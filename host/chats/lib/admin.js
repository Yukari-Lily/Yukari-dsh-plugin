/**
 * The chat inventory and its destructive half.
 *
 * One listing merges the Session corpus (`sessionQuery`), the durability
 * snapshots (`sessionPersistence`), the Workspace registry's archive and pin
 * sets, and — for artifacts on disk — the JSONL backend's own `locate()`.
 * A delete removes one artifact directory, then drops the id from the
 * workspace accounting, the archive set, and the pin set so the sidebar stops
 * accounting for a chat that no longer exists.
 *
 * Everything that touches the filesystem is injected, so the module is
 * exercised by `test/admin.test.mjs` without a Harness.
 * @module @local/chat-manager/admin
 */
import nodeFs from 'node:fs/promises'
import path from 'node:path'
import { removeCreatedFiles, removeWorkspaceDirectory } from './cleanup.js'
import { artifactDirectory, isArtifactDirectoryOf, isInside } from './paths.js'

/** HTTP prefix the panel and the tools share. */
export const API_PATH = '/chat-manager/api'

/** Largest id batch one delete request may carry. */
export const MAX_DELETE_IDS = 500

/** Most titles one listing folds from cold logs. */
export const DEFAULT_TITLE_BUDGET = 160

/** Turn any thrown value into a message. */
export const messageOf = (error) => (error instanceof Error ? error.message : String(error))

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
  const registry = optionalService(ctx, 'workspaceRegistry')
  const store = optionalService(ctx, 'sessions')
  const agents = optionalService(ctx, 'agents')
  const titles = optionalService(ctx, 'sessionTitle')
  const projectionCache = optionalService(ctx, 'sessionProjectionCache')

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
    if (projectionCache === undefined || typeof projectionCache.cachedSnapshot !== 'function') return null
    try {
      const snapshot = projectionCache.cachedSnapshot(header, ['title'])
      const value = snapshot?.values?.title
      return typeof value === 'string' && value !== '' ? value : null
    } catch {
      return null
    }
  }

  /** Latest title of one live Session. */
  function liveTitle(session) {
    if (session === undefined || titles === undefined || typeof titles.get !== 'function') return null
    try {
      const snapshot = titles.get(session)
      return typeof snapshot?.title === 'string' && snapshot.title !== '' ? snapshot.title : null
    } catch {
      return null
    }
  }

  function archivedSet() {
    try {
      return new Set(registry?.archivedSessionIds ?? [])
    } catch {
      return new Set()
    }
  }

  function pinnedSet() {
    try {
      return new Set(registry?.pinnedSessionIds ?? [])
    } catch {
      return new Set()
    }
  }

  function workspaceList() {
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
  async function directoryStat(directory) {
    if (directory === null) return null
    try {
      const info = await fs.stat(directory)
      return { mtimeMs: Number(info.mtimeMs), isDirectory: info.isDirectory() }
    } catch {
      return null
    }
  }

  /**
   * Fold titles for the ids whose cache carried none.
   * @returns id → title, plus a warning when the fold failed.
   */
  async function foldTitles(ids) {
    const found = new Map()
    if (ids.length === 0 || titleBudget === 0) return { found, warning: null }
    const batch = ids.slice(0, titleBudget)
    try {
      const results = await query.readTitleSnapshots(batch)
      for (const result of results ?? []) {
        if (result?.status !== 'fulfilled') continue
        const title = result.value?.title?.title
        if (typeof title === 'string' && title !== '') found.set(result.sessionId, title)
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

    const rows = []
    const pendingTitles = []
    for (const record of records) {
      const header = record.header
      const id = String(header.id)
      const session = store !== undefined && typeof store.get === 'function' ? store.get(id) : undefined
      const live = session !== undefined || record.live === true
      const running = agents !== undefined && typeof agents.get === 'function'
        ? agents.get(id)?.status === 'running'
        : false
      const title = liveTitle(session) ?? cachedTitle(header)
      if (title === null) pendingTitles.push(id)
      const workspace = byMember.get(id) ?? (header.cwd === undefined ? undefined : byPath.get(header.cwd))
      const directory = directoryOf(header)
      const item = durable.get(id)
      rows.push({
        id,
        title,
        cwd: header.cwd ?? null,
        workspaceId: workspace !== undefined ? workspace.id : null,
        workspaceTitle: workspace !== undefined ? workspace.title : null,
        createdAt: header.createdAt,
        persistedAt: null,
        bytes: typeof item?.sizeBytes === 'number' ? item.sizeBytes : null,
        events: typeof item?.eventCount === 'number' ? item.eventCount : null,
        live,
        running,
        persisted: record.persisted === true,
        archived: archived.has(id),
        pinned: pinned.has(id),
        origin: header.origin ?? null,
        parentSession: header.parentSession ?? null,
        delegationDepth: Number.isInteger(header.delegationDepth) ? header.delegationDepth : 0,
        agentPreset: header.agentPreset ?? null,
        directory,
      })
    }

    const { found, warning } = await foldTitles(pendingTitles)
    if (warning !== null) warnings.push(warning)

    for (const row of rows) {
      if (row.title === null) row.title = found.get(row.id) ?? null
      const info = await directoryStat(row.directory)
      row.stored = info !== null && info.isDirectory
      row.updatedAt = Math.max(row.createdAt, info?.mtimeMs ?? 0)
      delete row.directory
      delete row.persistedAt
    }

    rows.sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
      if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt
      return left.id < right.id ? -1 : 1
    })

    const totals = {
      all: rows.length,
      active: rows.filter((row) => !row.archived).length,
      archived: rows.filter((row) => row.archived).length,
      live: rows.filter((row) => row.live).length,
      running: rows.filter((row) => row.running).length,
      bytes: rows.reduce((sum, row) => sum + (typeof row.bytes === 'number' ? row.bytes : 0), 0),
    }

    return {
      generatedAt: new Date().toISOString(),
      root: root(),
      sessions: rows,
      workspaces,
      totals,
      warnings,
    }
  }

  /** Drop one id from the registry's accounting, archive, and pin bookkeeping. */
  async function forget(id, notes) {
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
   * Delete stored chats.
   * @param request - ids and whether a live Session may be removed too.
   * @returns how many artifacts were removed, and why the rest stayed.
   */
  async function remove(request = {}) {
    const requested = Array.isArray(request.ids) ? request.ids : []
    const ids = [...new Set(
      requested
        .filter((id) => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    )].slice(0, MAX_DELETE_IDS)
    const deleteFiles = request.deleteFiles === true
    const deleteWorkspaceDir = request.deleteWorkspaceDir === true
    const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''
    const workspacePath = typeof request.workspacePath === 'string' ? request.workspacePath.trim() : ''
    // `deleteWorkspace`: the request removes a whole workspace (its registration too).
    const deleteWorkspace = request.deleteWorkspace === true || deleteWorkspaceDir
    if (ids.length === 0 && !deleteWorkspace) throw new Error('没有指定要删除的会话')

    const records = await query.listSessions()
    const headers = new Map(records.map((record) => [String(record.header.id), record.header]))
    const sessionRoot = root()
    const workspaces = workspaceList()

    // The directory a workspace delete may remove: a registered workspace, or
    // the working directory of a chat in this very request. Never a client path alone.
    let workspaceDir = null
    const registered = deleteWorkspace ? workspaces.find((workspace) => workspace.id === workspaceId) ?? null : null
    if (deleteWorkspace && registered === null && ids.length === 0) throw new Error('找不到要删除的工作区')
    if (deleteWorkspaceDir) {
      if (registered !== null && registered.path !== '') {
        workspaceDir = registered.path
      } else if (workspacePath !== '' && ids.some((id) => headers.get(id)?.cwd === workspacePath)) {
        workspaceDir = workspacePath
      } else {
        throw new Error('找不到要删除的工作区目录')
      }
    }

    const deleted = []
    const failed = []
    const notes = []
    let filesDeleted = 0

    for (const id of ids) {
      const header = headers.get(id)
      const session = store !== undefined && typeof store.get === 'function' ? store.get(id) : undefined
      if (header === undefined) {
        failed.push({ id, reason: 'unknown' })
        continue
      }
      // A chat loaded in this process cannot be removed safely: its files would
      // vanish while the in-memory session keeps trying to append to them.
      if (session !== undefined) {
        failed.push({ id, reason: 'live' })
        continue
      }
      const directory = directoryOf(header)
      const info = directory === null ? null : await directoryStat(directory)
      if (info === null) {
        /* A created-but-never-materialized Session has no artifact to remove. */
        failed.push({ id, reason: session !== undefined ? 'in-memory' : 'no-artifact' })
        continue
      }
      if (!isInside(sessionRoot, directory) || !isArtifactDirectoryOf(sessionRoot, directory, id)) {
        failed.push({ id, reason: 'unsafe-path' })
        continue
      }
      // The workspace directory goes as a whole below; file-by-file is only for the rest.
      if (deleteFiles && !(workspaceDir !== null && header.cwd !== undefined && path.resolve(header.cwd) === path.resolve(workspaceDir))) {
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
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 2 })
      } catch (error) {
        failed.push({ id, reason: messageOf(error) })
        continue
      }
      deleted.push(id)
    }

    for (const id of deleted) await forget(id, notes)

    let workspaceDirDeleted = false
    let workspaceRemoved = false
    if (deleteWorkspace && failed.length > 0) {
      notes.push(`有 ${failed.length} 个会话没删掉，工作区${workspaceDir === null ? '' : `和目录 ${workspaceDir} `}已保留`)
    } else if (deleteWorkspace) {
      if (workspaceDir !== null) {
        const outcome = await removeWorkspaceDirectory(workspaceDir, [sessionRoot], fs)
        workspaceDirDeleted = outcome.removed
        notes.push(outcome.note)
      }
      // Drop the registration so the sidebar forgets the workspace, unless its directory was kept by a failure.
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
   * @param request - the id and the desired archive state.
   * @returns the accepted state.
   */
  async function setArchived(request = {}) {
    if (registry === undefined) throw new Error('这个组合里没有 workspaceRegistry，无法归档')
    const id = typeof request.id === 'string' ? request.id.trim() : ''
    if (id === '') throw new Error('没有指定会话')
    const archived = request.archived === true
    if (archived) await registry.archiveSession(id)
    else await registry.unarchiveSession(id)
    const state = await snapshot()
    return { id, archived, state }
  }

  /**
   * Drop archive, pin and workspace references to chats that no longer exist.
   *
   * A session deleted before this plugin refused loaded chats (or by hand) can
   * leave its id behind in the registry. The list never shows those ids, but
   * the stored sets keep them forever, so a boot-time pass makes the state
   * match the disk again.
   * @returns how many references were dropped.
   */
  async function prune() {
    const counts = { archived: 0, pinned: 0, detached: 0 }
    if (registry === undefined) return counts
    let records = []
    try {
      records = await query.listSessions()
    } catch {
      return counts
    }
    // An empty listing is far more likely to be a transient failure than a
    // genuinely empty store; pruning then would erase real archive marks.
    if (records.length === 0) return counts
    const alive = new Set(records.map((record) => String(record.header.id)))
    for (const id of archivedSet()) {
      if (alive.has(id)) continue
      try {
        await registry.unarchiveSession(id)
        counts.archived += 1
      } catch { /* an id the registry cannot act on is already gone */ }
    }
    for (const id of pinnedSet()) {
      if (alive.has(id)) continue
      try {
        await registry.unpinSession(id)
        counts.pinned += 1
      } catch { /* ignore */ }
    }
    if (typeof registry.list === 'function') {
      let entities = []
      try {
        entities = registry.list()
      } catch {
        entities = []
      }
      for (const workspace of entities) {
        let members = []
        try {
          members = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        } catch {
          members = []
        }
        for (const id of members) {
          if (alive.has(id) || typeof workspace.detachSession !== 'function') continue
          try {
            await workspace.detachSession(id)
            counts.detached += 1
          } catch { /* ignore */ }
        }
      }
    }
    return counts
  }

  return { root, snapshot, remove, setArchived, prune }
}
