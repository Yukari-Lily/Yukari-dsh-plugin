/**
 * The chat inventory and its destructive half.
 *
 * One listing merges the Session corpus (`sessionQuery`), the durability
 * snapshots (`sessionPersistence`), the Workspace registry's archive and pin
 * sets, and — for artifacts on disk — the JSONL backend's own `locate()`.
 *
 * A delete is a process action, not a filesystem one: the chat is flushed,
 * detached from the Session store and announced as removed, because a Host
 * that keeps a loaded chat whose log was unlinked goes on accepting messages
 * that are then lost without a trace. Only after that does the artifact go and
 * the id leave workspace accounting, the archive set, and the pin set.
 *
 * Everything that touches the filesystem is injected, so the module is
 * exercised by `test/admin.test.mjs` without a Harness.
 * @module @local/chat-manager/admin
 */
import { createHash } from 'node:crypto'
import nodeFs from 'node:fs/promises'
import path from 'node:path'
import { appError } from '../../shared/http.js'
import { removeCreatedFiles, removeWorkspaceDirectory } from './cleanup.js'
import { artifactDirectory, isArtifactDirectoryOf, isInside } from './paths.js'
import { previewOf } from './preview.js'

/** HTTP prefix the panel and the tools share. */
export const API_PATH = '/chat-manager/api'

/** Largest id batch one delete request may carry. */
export const MAX_DELETE_IDS = 500

/** Longest parent chain a delete cascade follows before the lineage counts as corrupt. */
export const MAX_LINEAGE_DEPTH = 64

/** Warning used when the Host cannot be asked whether a chat is still working. */
const NO_ACTIVITY_WATERFALL = '宿主未提供 workspace/session-activity，删除与归档前未询问会话活动状态。'

/** Directory stats run at most this many at a time. */
const STAT_CONCURRENCY = 8

/** Most titles one listing folds from cold logs. */
export const DEFAULT_TITLE_BUDGET = 160

/** Turn any thrown value into a message. */
export const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * The parent a chat really belongs to.
 *
 * Only a subagent owns a parent session. A historical fork keeps its source id
 * in `parentSession` without being a child of it, and treating that field as
 * lineage deletes an independent branch along with the chat the user picked.
 * @param header - one Session header.
 * @returns the parent id, or null when this chat is a root.
 */
export function lineageParentOf(header) {
  if (header?.origin !== 'subagent') return null
  const parent = header.parentSession
  return typeof parent === 'string' && parent !== '' ? parent : null
}

/**
 * Resolve every chat's parent into a forest the panel can recurse over.
 *
 * The panel nests and cascades on `parentSession` alone, so what it receives
 * has to be the Host's own definition of a child chat, and it has to be
 * acyclic: a header pair that names each other would otherwise recurse until
 * the panel dies. A link that closes a cycle is cut here and reported, so the
 * cut is visible instead of silently reshaping the tree.
 * @param headers - Session headers.
 * @returns parents by id (null for a root) and the ids whose link had to be cut.
 */
export function lineageForest(headers) {
  const parents = new Map()
  for (const header of headers) parents.set(String(header.id), lineageParentOf(header))
  const broken = []
  for (const start of parents.keys()) {
    const chain = []
    const seen = new Set()
    let current = start
    while (current !== null && !seen.has(current)) {
      seen.add(current)
      chain.push(current)
      current = parents.get(current) ?? null
    }
    // `current` is on this chain again: the last link closes the cycle.
    if (current !== null && seen.has(current)) {
      parents.set(chain[chain.length - 1], null)
      broken.push(chain[chain.length - 1])
    }
  }
  return { parents, broken }
}

/**
 * Every subagent descendant of the given roots, depth first.
 *
 * The panel expands a parent selection into its children before asking; the
 * Host does the same so a child filed under another workspace — or created
 * between the listing and the delete — cannot be left behind as an orphan.
 * `visited` keeps a malformed header pair from looping, and the depth cap
 * refuses a chain too long to be real instead of walking it.
 * @param headers - Session headers.
 * @param roots - ids the request named.
 * @returns descendant ids, roots excluded.
 */
export function subagentDescendants(headers, roots) {
  const children = new Map()
  for (const header of headers) {
    const parent = lineageParentOf(header)
    if (parent === null) continue
    const id = String(header.id)
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(id)
  }
  const found = []
  const visited = new Set(roots)
  const walk = (id, depth) => {
    if (depth > MAX_LINEAGE_DEPTH) {
      throw appError(`会话血统超过 ${MAX_LINEAGE_DEPTH} 层，已停止删除，请先核对会话血统`, 'chats-lineage-deep', { depth: MAX_LINEAGE_DEPTH })
    }
    for (const child of children.get(id) ?? []) {
      if (visited.has(child)) continue
      visited.add(child)
      found.push(child)
      walk(child, depth + 1)
    }
  }
  for (const root of roots) walk(root, 1)
  return found
}

/**
 * Compare two paths by where they really point.
 *
 * A workspace directory and a chat's `cwd` can name the same place in two
 * spellings (a symlinked home, `/tmp` on macOS, a case-insensitive volume), and
 * the guard that stops a folder delete from taking unselected chats compares
 * them. String comparison silently matched nothing there and the guard let the
 * whole directory go.
 * @param fs - filesystem seam.
 * @param target - path to canonicalize.
 * @returns the real path, or the resolved one when it cannot be resolved.
 */
export async function canonicalPath(fs, target) {
  if (typeof target !== 'string' || target === '') return null
  try {
    return await fs.realpath(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * Session-scoped directory the local spill backend keeps one session's files in.
 * @param root - the spill root.
 * @param id - the Session id.
 * @returns the absolute directory.
 */
export function spillDirectory(root, id) {
  return path.join(root, `session-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`)
}

/**
 * Read one optional Host service without requiring it in `inject`.
 * @param ctx - plugin context.
 * @param name - service key.
 * @returns the service, or undefined in compositions without it.
 */
export function optionalService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(name)
      if (value !== undefined) return value
    }
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * Resolve the directory holding Session artifacts.
 * @param args - persistence service, plugin config, and process environment.
 * @returns the absolute Session root.
 */
export function resolveRoot({ persistence, config = {}, env = process.env } = {}) {
  const configured = typeof config.sessionsRoot === 'string' ? config.sessionsRoot.trim() : ''
  if (configured !== '') return path.resolve(configured)
  const backendRoot = persistence !== undefined && typeof persistence.root === 'string' ? persistence.root : ''
  if (backendRoot !== '') return path.resolve(backendRoot)
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : path.join(env.HOME ?? '', '.dsh')
  return path.join(home, 'sessions')
}

/**
 * Ask a JSONL backend where it keeps one Session, when the backend can say.
 * @param persistence - the persistence service.
 * @param header - the Session header.
 * @returns the artifact directory, or null when the backend cannot locate it.
 */
export function locatedDirectory(persistence, header) {
  if (persistence === undefined || typeof persistence.locate !== 'function') return null
  try {
    const location = persistence.locate({ id: header.id, cwd: header.cwd })
    if (location !== null && typeof location === 'object' && typeof location.path === 'string' && location.path !== '') {
      return path.dirname(location.path)
    }
  } catch {
    /* a backend without a filesystem location simply falls through */
  }
  return null
}

/**
 * Build the admin surface over one plugin context.
 * @param args - plugin context, plugin config, and filesystem seams.
 * @returns listing, delete, and archive operations plus the resolved root.
 */
export function createAdmin({ ctx, config = {}, fs = nodeFs } = {}) {
  if (ctx === undefined || ctx === null) throw new Error('chat-manager: a plugin context is required')

  const query = optionalService(ctx, 'sessionQuery')
  const persistence = optionalService(ctx, 'sessionPersistence')
  if (query === undefined || typeof query.listSessions !== 'function') {
    throw new Error('chat-manager: sessionQuery is required')
  }
  /**
   * Optional services are resolved per call, never captured once: a Service that
   * is still initializing while this row loads reads as undefined here and is
   * present a moment later. Capturing that undefined disabled archiving for the
   * whole process ("这个组合里没有 workspaceRegistry").
   */
  const optional = (name) => optionalService(ctx, name)

  /**
   * Ids whose artifact was deleted while the chat was still loaded in this
   * process. The Session store keeps such a chat until its Agent is released,
   * and `sessionQuery.listSessions()` merges live sessions into its listing, so
   * without this the row would come straight back as a missing record.
   * Process-local on purpose: after a restart the store holds neither.
   */
  const removed = new Set()

  /**
   * Titles already folded from cold logs, keyed by id and remembered revision.
   *
   * The listing folds a bounded number of logs per call, so without this memory
   * the same 160 chats were re-read on every request while the rest never got a
   * title at all. A null title is remembered too: a chat with no logged title
   * must not keep spending the budget that the others need.
   */
  const titleMemory = new Map()

  const titleBudget = Number.isFinite(Number(config.titleBudget)) && Number(config.titleBudget) >= 0
    ? Math.floor(Number(config.titleBudget))
    : DEFAULT_TITLE_BUDGET

  /**
   * The JSONL root this deployment stores artifacts under.
   * @returns the absolute root directory.
   */
  function root() {
    return resolveRoot({ persistence, config, env: process.env })
  }

  /** Cached title of one cold Session, without re-reading its log. */
  function cachedTitle(header) {
    const cache = optional('sessionProjectionCache')
    if (cache === undefined || typeof cache.cachedSnapshot !== 'function') return null
    try {
      const snapshot = cache.cachedSnapshot(header, ['title'])
      const value = snapshot?.values?.title
      return typeof value === 'string' && value !== '' ? value : null
    } catch {
      return null
    }
  }

  /** Latest title of one live Session. */
  function liveTitle(session) {
    const titleService = optional('sessionTitle')
    if (session === undefined || titleService === undefined || typeof titleService.get !== 'function') return null
    try {
      const snapshot = titleService.get(session)
      return typeof snapshot?.title === 'string' && snapshot.title !== '' ? snapshot.title : null
    } catch {
      return null
    }
  }

  function archivedSet() {
    try {
      return new Set(optional('workspaceRegistry')?.archivedSessionIds ?? [])
    } catch {
      return new Set()
    }
  }

  function pinnedSet() {
    try {
      return new Set(optional('workspaceRegistry')?.pinnedSessionIds ?? [])
    } catch {
      return new Set()
    }
  }

  function workspaceList() {
    const registry = optional('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return []
    try {
      return registry.list().map((workspace) => ({
        id: String(workspace.id),
        title: String(workspace.title ?? ''),
        path: String(workspace.path ?? ''),
        sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
      }))
    } catch {
      return []
    }
  }

  /** Artifact directory for one header, preferring the backend's own answer. */
  function directoryOf(header) {
    const located = locatedDirectory(persistence, header)
    if (located !== null) return located
    try {
      return artifactDirectory(root(), header.cwd, header.id)
    } catch {
      return null
    }
  }

  /**
   * Read one artifact directory's own metadata.
   * @returns byte size and last-modified instant, when the directory exists.
   */
  async function pathStat(target) {
    if (target === null) return null
    try {
      const info = await fs.stat(target)
      return { mtimeMs: Number(info.mtimeMs), isDirectory: info.isDirectory(), isFile: info.isFile() }
    } catch {
      return null
    }
  }

  /**
   * Fold titles for the chats whose projection cache carried none.
   *
   * Every answer is remembered against the log revision it was folded from, so
   * the next listing reads no log again until that revision changes; the budget
   * then advances through the chats that still have no title instead of
   * re-reading the same first ones.
   * @param entries - `{ id, revision }`, in listing order.
   * @returns the titles this call; a warning when the fold failed outright.
   */
  async function foldTitles(entries) {
    const found = new Map()
    if (entries.length === 0 || titleBudget === 0) return { found, warning: null }
    const batch = entries.slice(0, titleBudget)
    try {
      const results = await query.readTitleSnapshots(batch.map((entry) => entry.id))
      const answered = new Map()
      for (const result of results ?? []) {
        if (result?.status !== 'fulfilled') continue
        const title = result.value?.title?.title
        answered.set(String(result.sessionId), typeof title === 'string' && title !== '' ? title : null)
      }
      for (const entry of batch) {
        // A rejected read is a failing log, not a chat without a title: leave it
        // out of the memory so the next listing tries it again.
        if (!answered.has(entry.id)) continue
        const title = answered.get(entry.id)
        if (entry.revision !== null) titleMemory.set(entry.id, { revision: entry.revision, title })
        if (title !== null) found.set(entry.id, title)
      }
      return { found, warning: null }
    } catch (error) {
      return { found, warning: `标题回放失败：${messageOf(error)}` }
    }
  }

  /**
   * Every chat this Host can see, newest activity first.
   * @returns a JSON-safe state document for the panel.
   */
  async function snapshot() {
    const warnings = []
    const store = optional('sessions')
    const records = await query.listSessions()

    const durable = new Map()
    if (persistence !== undefined && typeof persistence.list === 'function') {
      try {
        for (const item of await persistence.list()) durable.set(String(item.header.id), item)
      } catch (error) {
        warnings.push(`读取会话存储失败：${messageOf(error)}`)
      }
    }

    const archived = archivedSet()
    const pinned = pinnedSet()
    const workspaces = workspaceList()
    const byPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
    const byMember = new Map()
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) byMember.set(sessionId, workspace)
    }

    const { parents, broken } = lineageForest(records.map((record) => record.header))
    for (const id of broken) warnings.push(`会话 ${id} 的父会话关系存在环，已按根会话展示。`)

    const rows = []
    const pendingTitles = []
    for (const record of records) {
      const header = record.header
      const id = String(header.id)
      if (removed.has(id)) continue
      const session = store !== undefined && typeof store.get === 'function' ? store.get(id) : undefined
      const live = session !== undefined || record.live === true
      const item = durable.get(id)
      const revision = typeof item?.revision === 'string' && item.revision !== '' ? item.revision : null
      const agents = optional('agents')
      const running = agents !== undefined && typeof agents.get === 'function'
        ? agents.get(id)?.status === 'running'
        : false
      const remembered = revision === null ? undefined : titleMemory.get(id)
      const title = liveTitle(session)
        ?? cachedTitle(header)
        ?? (remembered !== undefined && remembered.revision === revision ? remembered.title : null)
      if (title === null) pendingTitles.push({ id, revision })
      const workspace = byMember.get(id) ?? (header.cwd === undefined ? undefined : byPath.get(header.cwd))
      const directory = directoryOf(header)
      // The store names the artifact it actually reads; the directory only dates
      // creation and rotation, so activity has to come from the file itself.
      const artifact = typeof item?.location?.path === 'string' && item.location.path !== '' ? item.location.path : null
      rows.push({
        id,
        title,
        cwd: header.cwd ?? null,
        workspaceId: workspace !== undefined ? workspace.id : null,
        workspaceTitle: workspace !== undefined ? workspace.title : null,
        createdAt: header.createdAt,
        artifact,
        bytes: typeof item?.sizeBytes === 'number' ? item.sizeBytes : null,
        live,
        running,
        persisted: record.persisted === true,
        archived: archived.has(id),
        pinned: pinned.has(id),
        origin: header.origin ?? null,
        parentSession: parents.get(id) ?? null,
        delegationDepth: Number.isInteger(header.delegationDepth) ? header.delegationDepth : 0,
        agentPreset: header.agentPreset ?? null,
        directory,
      })
    }

    const { found, warning } = await foldTitles(pendingTitles)
    if (warning !== null) warnings.push(warning)

    // Bounded concurrency: one stat per row, at most eight in flight, so a
    // thousand chats cost a few hundred milliseconds instead of a minute.
    let cursor = 0
    const worker = async () => {
      while (cursor < rows.length) {
        const row = rows[cursor]
        cursor += 1
        if (row.title === null) row.title = found.get(row.id) ?? null
        const info = await pathStat(row.artifact ?? row.directory)
        row.stored = info !== null && (info.isFile || info.isDirectory)
        row.updatedAt = Math.max(row.createdAt, info?.mtimeMs ?? 0)
        delete row.artifact
        delete row.directory
      }
    }
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, rows.length) }, worker))

    rows.sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
      if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt
      return left.id < right.id ? -1 : 1
    })

    // 子会话在面板里折在父会话下面，只是父会话的一部分：把它们的条数与体积
    // 算进总数会出现"共 27 个会话"而界面上只有 12 条。计数的口径与界面上
    // 的一级会话保持一致，`sessions` 里仍然带着子会话，删除照样能级联。
    const roots = rows.filter((row) => row.parentSession === null)
    const totals = {
      all: roots.length,
      active: roots.filter((row) => !row.archived).length,
      archived: roots.filter((row) => row.archived).length,
      live: roots.filter((row) => row.live).length,
      running: roots.filter((row) => row.running).length,
      bytes: roots.reduce((sum, row) => sum + (typeof row.bytes === 'number' ? row.bytes : 0), 0),
    }

    return {
      generatedAt: new Date().toISOString(),
      root: root(),
      sessions: rows,
      workspaces,
      totals,
      warnings,
      // Whether archive/unarchive can work here at all; the panel hides the
      // control instead of letting a click fail.
      canArchive: typeof optional('workspaceRegistry')?.archiveSession === 'function',
    }
  }

  /** Drop one id from the registry's accounting, archive, and pin bookkeeping. */
  async function forget(id, notes) {
    const registry = optional('workspaceRegistry')
    if (registry === undefined) return
    if (typeof registry.list === 'function') {
      let entities = []
      try {
        entities = registry.list()
      } catch {
        entities = []
      }
      for (const workspace of entities) {
        let member = false
        try {
          member = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id)
        } catch {
          member = false
        }
        if (!member || typeof workspace.detachSession !== 'function') continue
        try {
          await workspace.detachSession(id)
        } catch (error) {
          notes.push(`工作区记账未清理（${messageOf(error)}）`)
        }
      }
    }
    for (const method of ['unarchiveSession', 'unpinSession']) {
      if (typeof registry[method] !== 'function') continue
      try {
        await registry[method](id)
      } catch {
        /* an id that was neither archived nor pinned is a no-op, not a failure */
      }
    }
  }

  /**
   * Ask the Host's own admission waterfall whether a chat still has work.
   *
   * `agents.status` only knows about a running turn of the chat itself; a
   * subagent, a job, or a schedule keeps working without it, and the Host asks
   * this same waterfall before its own archive action. Deleting on the Agent
   * status alone left those chats writing into a log nobody would read again.
   * @param id - the Session id.
   * @param notes - warnings collected for this request.
   * @returns the reported activity; empty when the chat is idle.
   */
  async function activityOf(id, notes) {
    if (typeof ctx.waterfall !== 'function') {
      // 没有 waterfall 就只剩智能体状态可问；降级本身要说出来，不能当作已确认空闲。
      if (!notes.includes(NO_ACTIVITY_WATERFALL)) notes.push(NO_ACTIVITY_WATERFALL)
      const agents = optional('agents')
      const running = agents !== undefined && typeof agents.get === 'function' && agents.get(id)?.status === 'running'
      return running ? [{ kind: 'turn' }] : []
    }
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
    return Array.isArray(activity) ? activity : []
  }

  /**
   * Take one loaded chat out of this process before its artifact goes away.
   *
   * Flushing first drains what is still buffered, detaching closes the write
   * handle, and the store then emits `session/disposed` — which is what the
   * Host's sidebar listens to. Without the detach the next append writes into an
   * unlinked inode: the message is accepted and gone.
   * @param id - the Session id.
   * @param notes - warnings collected for this request.
   * @returns whether a loaded chat was released.
   */
  async function releaseLive(id, notes) {
    const store = optional('sessions')
    if (store === undefined || typeof store.get !== 'function') return false
    const live = store.get(id)
    if (live === undefined) return false
    if (typeof store.flush === 'function') {
      try {
        await store.flush(live)
      } catch (error) {
        // 转录已经写不下去时这里会失败；删除仍要继续，但失败要出现在 warnings 里。
        notes.push(`会话缓冲区未能写盘（${messageOf(error)}）`)
      }
    }
    if (typeof store.liveEntryFor !== 'function' || typeof store.detachEntered !== 'function') {
      throw new Error('会话服务未提供 liveEntryFor/detachEntered，无法在删除前分离会话')
    }
    store.detachEntered(store.liveEntryFor(live))
    return true
  }

  /** Tell every connected client that this chat no longer exists. */
  function announceRemoval(id, notes) {
    if (typeof ctx.emit !== 'function') {
      notes.push('宿主未提供事件总线，会话移除通知未发出。')
      return
    }
    try {
      ctx.emit('api-session/removed', id)
    } catch (error) {
      notes.push(`会话移除通知未发出（${messageOf(error)}）`)
    }
  }

  /** Drop one session's projection-cache row; it is derived data, so a failure is a warning. */
  async function dropProjection(id, notes) {
    const cache = optional('sessionProjectionCache')
    if (cache === undefined || typeof cache.requireTable !== 'function') return
    try {
      await cache.requireTable().delete(id)
    } catch (error) {
      notes.push(`投影缓存行未清理（${messageOf(error)}）`)
    }
  }

  /** Best-effort removal of the spill directory the local backend keeps for one session. */
  async function dropSpill(id, notes) {
    const spill = optional('spillStore')
    if (spill === undefined || typeof spill.root !== 'string' || spill.root === '') return
    try {
      await fs.rm(spillDirectory(spill.root, id), { recursive: true, force: true })
    } catch (error) {
      notes.push(`临时转储目录未清理（${messageOf(error)}）`)
    }
  }

  /**
   * Delete stored chats. A chat that is merely loaded goes too; only one the
   * Host reports as still working stays, because its remaining events would
   * have nowhere to land.
   * @param request - ids, plus the optional file and workspace cleanup flags.
   * @returns how many artifacts were removed, and why the rest stayed.
   */
  async function remove(request = {}) {
    const requested = Array.isArray(request.ids) ? request.ids : []
    const ids = [...new Set(
      requested
        .filter((id) => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    )]
    const deleteFiles = request.deleteFiles === true
    const deleteWorkspaceDir = request.deleteWorkspaceDir === true
    const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''
    const workspacePath = typeof request.workspacePath === 'string' ? request.workspacePath.trim() : ''
    // `deleteWorkspace`: the request removes a whole workspace (its registration too).
    const deleteWorkspace = request.deleteWorkspace === true || deleteWorkspaceDir
    if (ids.length === 0 && !deleteWorkspace) throw appError('未指定要删除的会话', 'chats-no-selection')

    const records = await query.listSessions()
    const headers = new Map(records.map((record) => [String(record.header.id), record.header]))
    const sessionRoot = root()
    const workspaces = workspaceList()

    // Subagent chats go with their parent; fork branches do not, because
    // `parentSession` on those names a source rather than a parent.
    const targets = new Set(ids)
    for (const id of subagentDescendants(headers.values(), ids)) targets.add(id)

    // The directory a workspace delete may remove: a registered workspace, or
    // the working directory of a chat in this very request. Never a client path alone.
    let workspaceDir = null
    const registered = deleteWorkspace ? workspaces.find((workspace) => workspace.id === workspaceId) ?? null : null
    if (deleteWorkspace && registered === null && ids.length === 0) throw new Error('找不到要删除的工作区')
    if (deleteWorkspaceDir) {
      if (registered !== null && registered.path !== '') {
        workspaceDir = registered.path
      } else if (workspacePath !== '' && [...targets].some((id) => headers.get(id)?.cwd === workspacePath)) {
        workspaceDir = workspacePath
      } else {
        throw new Error('找不到要删除的工作区目录')
      }
    }
    // 守护与后续的逐文件清理都要用同一个真实路径，否则符号链接或大小写不同的
    // 两种写法会让"目录里还有未选中会话"这条判断看到零个。
    const workspaceTarget = workspaceDir === null ? null : await canonicalPath(fs, workspaceDir)
    if (workspaceTarget !== null) {
      // Removing the folder takes every chat living in it, so refuse when some of
      // them were not part of this request: the caller can select them and retry.
      const cwdAliases = new Map()
      const canonicalCwd = async (cwd) => {
        if (!cwdAliases.has(cwd)) cwdAliases.set(cwd, await canonicalPath(fs, cwd))
        return cwdAliases.get(cwd)
      }
      let survivors = 0
      for (const record of records) {
        const cwd = record.header?.cwd
        if (typeof cwd !== 'string' || targets.has(String(record.header.id))) continue
        if (await canonicalCwd(cwd) === workspaceTarget) survivors += 1
      }
      if (survivors > 0) {
        throw appError(`该目录中还有 ${survivors} 个未选中的会话，请一并选中后再删除目录`, 'chats-unselected-remain', { count: survivors })
      }
    }
    // 截断要发生在校验之后：静默少删会留下用户以为已经删掉的会话。
    if (targets.size > MAX_DELETE_IDS) {
      const error = new Error(`本次请求包含 ${targets.size} 个会话（含子会话），一次最多删除 ${MAX_DELETE_IDS} 个，请分批删除`)
      error.appCode = 'delete-too-many'
      error.params = { count: targets.size, limit: MAX_DELETE_IDS }
      throw error
    }

    const deleted = []
    const failed = []
    const notes = []
    let filesDeleted = 0

    for (const id of targets) {
      const header = headers.get(id)
      if (header === undefined) {
        failed.push({ id, reason: 'unknown' })
        continue
      }
      let activity
      try {
        activity = await activityOf(id, notes)
      } catch (error) {
        failed.push({ id, reason: 'activity-error', detail: `无法确认会话是否仍在工作：${messageOf(error)}` })
        continue
      }
      if (activity.length > 0) {
        failed.push({ id, reason: 'running' })
        continue
      }
      const directory = directoryOf(header)
      const info = directory === null ? null : await pathStat(directory)
      if (info !== null && (!isInside(sessionRoot, directory) || !isArtifactDirectoryOf(sessionRoot, directory, id))) {
        failed.push({ id, reason: 'unsafe-path' })
        continue
      }
      const store = optional('sessions')
      const session = store !== undefined && typeof store.get === 'function' ? store.get(id) : undefined
      if (info === null && session === undefined) {
        // 既没有工件也不在本进程里，没有可删的东西。
        failed.push({ id, reason: 'no-artifact' })
        continue
      }
      // The workspace directory goes as a whole below; file-by-file is only for the rest.
      if (info !== null && deleteFiles
        && !(workspaceTarget !== null && header.cwd !== undefined && await canonicalPath(fs, header.cwd) === workspaceTarget)) {
        const cleaned = await removeCreatedFiles({
          persistence,
          header,
          directory,
          roots: workspaces.map((workspace) => workspace.path),
          fs,
        })
        filesDeleted += cleaned.removed
        notes.push(...cleaned.notes)
      }
      try {
        await releaseLive(id, notes)
      } catch (error) {
        failed.push({ id, reason: 'detach-failed', detail: `会话无法从存储分离：${messageOf(error)}` })
        continue
      }
      await dropProjection(id, notes)
      if (info !== null) {
        try {
          await fs.rm(directory, { recursive: true, force: true, maxRetries: 2 })
        } catch (error) {
          failed.push({ id, reason: 'io-error', detail: messageOf(error) })
          continue
        }
        await dropSpill(id, notes)
      }
      deleted.push(id)
      if (session !== undefined) removed.add(id)
      titleMemory.delete(id)
      // Forget the id immediately: a crash between removing the artifact and
      // dropping its references would otherwise leave an invisible leftover.
      await forget(id, notes)
      announceRemoval(id, notes)
    }

    let workspaceDirDeleted = false
    let workspaceRemoved = false
    if (deleteWorkspace && failed.length > 0) {
      notes.push(`有 ${failed.length} 个会话删除失败，工作区${workspaceDir === null ? '' : `和目录 ${workspaceDir} `}已保留`)
    } else if (deleteWorkspace) {
      if (workspaceDir !== null) {
        // 用规范化后的路径删除：同一目录的另一种写法在符号链接下并不指向同一处。
        const outcome = await removeWorkspaceDirectory(workspaceTarget ?? workspaceDir, [sessionRoot], fs)
        workspaceDirDeleted = outcome.removed
        if (outcome.note) notes.push(outcome.note)
      }
      // Drop the registration so the sidebar forgets the workspace, unless its directory was kept by a failure.
      const registry = optional('workspaceRegistry')
      if (registered !== null && (workspaceDir === null || workspaceDirDeleted) && registry !== undefined && typeof registry.delete === 'function') {
        try {
          workspaceRemoved = (await registry.delete(registered.id)) !== false
        } catch (error) {
          notes.push(`工作区登记未移除（${messageOf(error)}）`)
        }
      }
    }

    const state = await snapshot()
    return {
      deleted: deleted.length,
      ids: deleted,
      failed,
      filesDeleted,
      workspaceDirDeleted,
      workspaceRemoved,
      notes,
      state,
    }
  }

  /**
   * Move one chat in or out of the registry archive set.
   *
   * Archiving asks the same admission waterfall the delete does. The registry
   * refuses an active session on its own, in the Host's English words, which the
   * panel would then show verbatim; asking first lets this answer in the panel's
   * language, and lets a caller that asked for it stop the work instead.
   * @param request - the id, the desired archive state, and whether running work may be stopped.
   * @returns the accepted state, plus any warning the admission check produced.
   */
  async function setArchived(request = {}) {
    const registry = optional('workspaceRegistry')
    if (registry === undefined || typeof registry.archiveSession !== 'function') {
      throw new Error('当前组合未提供归档能力（缺少 workspaceRegistry 服务），无法归档或取消归档')
    }
    const id = typeof request.id === 'string' ? request.id.trim() : ''
    if (id === '') throw new Error('未指定会话')
    const archived = request.archived === true
    const notes = []
    if (!archived) {
      await registry.unarchiveSession(id)
    } else {
      const activity = await activityOf(id, notes)
      if (activity.length > 0 && request.stopActivity !== true) {
        const kinds = activity.map((entry) => entry?.kind).filter((kind) => typeof kind === 'string')
        throw new Error(`会话仍有未结束的工作${kinds.length === 0 ? '' : `（${kinds.join('、')}）`}，请先停止后再归档`)
      }
      // 归档集合本身就是 stopActivity 停止后那些唤醒要读的准入凭据，所以先写集合再停。
      await registry.archiveSession(id, activity.length > 0 ? { stopActivity: true } : undefined)
    }
    const state = await snapshot()
    return { id, archived, notes, state }
  }

  /**
   * 一条会话的最后几条对话，供面板的悬停卡片使用。
   *
   * 优先读进程里那份，没加载过才去翻磁盘：预览是只读的，读不到就当 404，不能
   * 让它把别的操作拖住。
   * @param request - `{ sessionId, limit }`。
   * @returns `{ id, turns, messages, live }`。
   */
  async function preview({ sessionId, limit } = {}) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') throw appError('未指定要预览的会话', 'chats-preview-no-session')
    if (id === '.' || id === '..' || !/^[A-Za-z0-9._-]+$/.test(id)) throw appError('会话 id 不合法', 'chats-preview-bad-id')
    const count = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Math.floor(Number(limit)), 20) : undefined
    const sessionsService = optional('sessions')
    const live = sessionsService !== undefined && typeof sessionsService.get === 'function' ? sessionsService.get(id) : undefined
    if (live !== undefined && typeof live.snapshotEvents === 'function') {
      return { id, live: true, ...previewOf(live.snapshotEvents(), count) }
    }
    if (persistence === undefined || typeof persistence.open !== 'function') {
      throw appError('找不到会话。', 'chats-preview-missing', undefined, 404)
    }
    let handle = null
    try {
      handle = await persistence.open(id, 'read')
      const read = await handle.read()
      return { id, live: false, ...previewOf(read?.events ?? [], count) }
    } catch (error) {
      throw appError(`找不到会话：${messageOf(error)}`, 'chats-preview-missing', undefined, 404)
    } finally {
      try {
        await handle?.close()
      } catch {
        /* 读句柄关不掉不影响结果 */
      }
    }
  }

  return { root, snapshot, remove, setArchived, preview }
}
