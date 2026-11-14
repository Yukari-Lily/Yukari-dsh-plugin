/**
 * Yukari Rules: operator constraints, injected as system prompt text.
 *
 * Two files hold the whole state:
 * - `$DSH_HOME/rules.md` applies to every session;
 * - `<project root>/rules.md` applies to the sessions working under it.
 *
 * 两个 section：完整约束在文首（-950），文末锚点（10400）只重复全局那份短约束，
 * 工作区那份可能很长，尾部不重复。文件每轮重新读取拼接，保存或外部修改在下一步
 * 生效，不需要重启。
 *
 * The panel edits the same files through `/rules/api`, which is why the
 * injection path never trusts a request for a directory: reads and writes are
 * resolved against the workspace registry and confined to the two fixed files.
 * @module yukari-dsh-plugin/rules
 */
import fs from 'node:fs'
import path from 'node:path'
import { markMounted } from '../shared/mounted.js'
import { BODY_LIMITS, appError, guardRoute, messageOf, readJsonBody, sendJson } from '../shared/http.js'
import { resolveAgentsHome, resolveDshHome } from '../shared/home.js'
import { globalFile, importCandidates, isInside, RULES_FILE, settingsFile, workspaceFile } from './lib/paths.js'
import { assertWritable, createDocCache, inspectDoc, realPathOf, removeDoc, writeDoc } from './lib/store.js'
import { renderRules, RULES_ANCHOR_SECTION, RULES_ORDER, RULES_SECTION, ANCHOR_ORDER } from './lib/render.js'
import { resolveScope, serviceOf, sessionOf, workspaceList } from './lib/scope.js'
import { pickSwitches, readSettings, writeSettings } from './lib/settings.js'

/** JSON API prefix served to the panel. */
export const API_PATH = '/rules/api'

/** Services this component needs. */
export const inject = ['systemPrompt', 'webServer', 'connection']

/** Per-file injection ceiling unless the row says otherwise. */
const DEFAULT_MAX_BYTES = 16384
/** The largest ceiling the panel can save through one JSON body. */
const HARD_MAX_BYTES = 122880
/** The editor may read more than the injection ceiling; it must not be silently cut. */
const DOC_LIMIT = 1048576
/** How many sessions the recent list may remember. */
const SESSION_CAP = 500
/** How many recent injections are kept in memory. */
const RECENT_CAP = 20

/** Clamp the row's byte ceiling into the range the API can carry. */
function normalizeMaxBytes(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_BYTES
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return DEFAULT_MAX_BYTES
  return Math.min(HARD_MAX_BYTES, Math.max(1024, number))
}

function shortId(id) {
  const text = typeof id === 'string' ? id : ''
  return text.length > 10 ? text.slice(0, 10) : text
}

/**
 * Whether an assembly belongs to a delegated child.
 *
 * 按 0.2.2 的头部语义判定：普通 fork 不再记录来源，历史 fork 残留的
 * `parentSession` 也不代表子会话，只有 `origin` 与层级说明血缘。
 */
function isSubagentContext(context) {
  const header = sessionOf(context)?.header
  if (!header) return false
  return header.origin === 'subagent' || (Number.isInteger(header.delegationDepth) && header.delegationDepth > 0)
}

/**
 * Active backstop per prompt host, so a hot reload can undo the previous layer.
 *
 * Purge also wraps `assemble` and loads after this component, so this wrapper
 * usually ends up *inside* another one. A disposer that only recognises
 * `assemble === wrapped` would then never match and the old layer would keep
 * injecting after the row is disabled.
 */
const backstops = new WeakMap()

/**
 * Install the assemble() backstop.
 *
 * Registry sections are the primary seam, but a `complete: true` section is
 * restored after the assembly waterfall and would drop them. The wrapper is the
 * only place that sees that finished assembly.
 */
function installBackstop(promptHost, build, logger) {
  if (!promptHost || typeof promptHost.assemble !== 'function') return null

  // A reload applies again: drop the layer the previous apply left behind, or
  // every reload would stack one more closure holding a full apply scope.
  const previous = backstops.get(promptHost)
  if (typeof previous === 'function') previous()
  const stale = promptHost.assemble
  if (stale && typeof stale._yukariRulesDispose === 'function') stale._yukariRulesDispose()

  const original = promptHost.assemble
  if (typeof original !== 'function') return null

  const slot = { build }
  const wrapped = async function assembleWithRules(...args) {
    const assembled = await original.apply(promptHost, args)
    if (typeof slot.build !== 'function') return assembled
    try {
      return ensureSections(assembled, args[0], slot.build)
    } catch (error) {
      logger?.warn?.(`yukari-rules: 后备注入失败: ${messageOf(error)}`)
      return assembled
    }
  }
  wrapped._yukariRulesWrapped = true
  wrapped._yukariRulesSlot = slot

  let released = false
  const dispose = () => {
    if (released) return
    released = true
    // Clearing the slot revokes this layer even when another component wrapped
    // the function afterwards: the outer wrapper still calls us, we just pass
    // the assembly through untouched.
    slot.build = null
    if (promptHost.assemble === wrapped) promptHost.assemble = original
    if (backstops.get(promptHost) === dispose) backstops.delete(promptHost)
  }
  wrapped._yukariRulesDispose = dispose

  try {
    promptHost.assemble = wrapped
  } catch {
    return null
  }

  backstops.set(promptHost, dispose)
  return dispose
}

/** Re-add the two sections when something after the registry removed them. */
function ensureSections(assembled, context, build) {
  if (!assembled || !Array.isArray(assembled.sections)) return assembled
  const hasHead = assembled.sections.some((section) => section?.name === RULES_SECTION && String(section?.text ?? '') !== '')
  const hasAnchor = assembled.sections.some((section) => section?.name === RULES_ANCHOR_SECTION && String(section?.text ?? '') !== '')
  if (hasHead && hasAnchor) return assembled

  const built = build(context)
  const { head, anchor } = built.rendered
  const needHead = head !== '' && !hasHead
  const needAnchor = anchor !== '' && !hasAnchor
  if (!needHead && !needAnchor) return assembled

  let sections = assembled.sections
  if (needHead) {
    sections = [{ name: RULES_SECTION, text: head, interpolate: false }, ...sections.filter((section) => section?.name !== RULES_SECTION)]
    built.record?.()
  }
  if (needAnchor) {
    sections = [...sections.filter((section) => section?.name !== RULES_ANCHOR_SECTION), { name: RULES_ANCHOR_SECTION, text: anchor, interpolate: false }]
  }
  return { ...assembled, sections }
}

/** Register the host half. */
export function apply(ctx, config = {}) {
  const maxBytes = normalizeMaxBytes(config.maxBytes)
  const dshHome = resolveDshHome()
  const agentsHome = resolveAgentsHome()
  const globalPath = globalFile(dshHome)
  const settingsPath = settingsFile(dshHome)
  const cache = createDocCache()

  markMounted(ctx, 'rules', { globalFile: globalPath, workspaceFile: RULES_FILE, maxBytes })

  let settings = readSettings(settingsPath, {
    global: config.global,
    project: config.project,
    tailAnchor: config.tailAnchor,
  })

  const stats = {
    assembled: 0,
    globalHits: 0,
    projectHits: 0,
    bytes: 0,
    lastAt: null,
    recent: [],
  }
  const sessions = new Set()
  const warned = new Set()
  let probing = false

  function warnOnce(key, error) {
    if (warned.has(key)) return
    if (warned.size >= 50) warned.clear()
    warned.add(key)
    ctx.logger?.warn?.(`yukari-rules: ${key}: ${messageOf(error)}`)
  }

  /**
   * Why the workspace list is untrustworthy, or null.
   * The panel reads this field so a fallback to the process cwd is visible.
   */
  let workspacesDegraded = null

  /** Workspaces for both the panel and the injector, recording any fallback. */
  function workspaces() {
    let degraded = null
    const list = workspaceList(ctx, {
      onDegrade(info) {
        degraded = info
      },
    })
    workspacesDegraded = degraded
    if (degraded !== null) warnOnce('workspace-registry', new Error(degraded.message))
    return list
  }

  /** The injector needs the same warning even when the panel is not open. */
  function scopeDegraded(info) {
    warnOnce('workspace-registry', new Error(info.message))
  }

  /* ----------------------------------------------------------- reading docs */

  /** A workspace file that resolves outside its workspace is not a constraint. */
  function projectDocFor(file, root) {
    const doc = cache.read(file, maxBytes)
    if (!doc.exists) return doc
    const realFile = realPathOf(file)
    const realRoot = realPathOf(root)
    if (realFile !== null && realRoot !== null && !isInside(realRoot, realFile)) {
      warnOnce(`escape:${file}`, new Error('rules.md 指向工作区外，已忽略'))
      return { ...doc, exists: false, text: '', bytes: 0, truncated: false }
    }
    return doc
  }

  /** Read both files and render one constraint body. */
  function build(context) {
    const session = sessionOf(context)
    const scope = resolveScope(ctx, session, { onDegrade: scopeDegraded })
    const globalDoc = cache.read(globalPath, maxBytes)
    const projectDoc = scope.file === null ? null : projectDocFor(scope.file, scope.projectRoot)
    const rendered = renderRules({
      global: globalDoc,
      project: projectDoc,
      enabled: settings,
      tailAnchor: settings.tailAnchor,
      maxBytes,
    })
    return { session, scope, globalDoc, projectDoc, rendered }
  }

  /* --------------------------------------------------------------- tracking */

  function record(context, built) {
    if (probing) return
    const session = built.session
    const id = session?.id
    if (typeof id === 'string' && id !== '') {
      if (!sessions.has(id) && sessions.size >= SESSION_CAP) {
        const oldest = sessions.keys().next().value
        if (oldest !== undefined) sessions.delete(oldest)
      }
      sessions.add(id)
    }
    stats.assembled += 1
    if (built.rendered.scopes.global) stats.globalHits += 1
    if (built.rendered.scopes.project) stats.projectHits += 1
    stats.bytes = built.rendered.bytes.head + built.rendered.bytes.anchor
    stats.lastAt = new Date().toISOString()
    const workspace = built.scope.workspace
    const scopeName = workspace?.title ?? (built.scope.projectRoot === null ? '' : path.basename(built.scope.projectRoot))
    stats.recent.push({
      at: stats.lastAt,
      session: shortId(id),
      origin: isSubagentContext(context) ? 'subagent' : 'main',
      workspace: scopeName,
      bytes: stats.bytes,
    })
    if (stats.recent.length > RECENT_CAP) stats.recent.splice(0, stats.recent.length - RECENT_CAP)
  }

  /** The `build` result plus the stats callback the backstop uses. */
  function buildTracked(context) {
    const built = build(context)
    return { ...built, record: () => record(context, built) }
  }

  /* ---------------------------------------------------------------- sections */

  function registerSection(name, order, provider) {
    try {
      const dispose = ctx.systemPrompt?.section?.({
        name,
        order,
        interpolate: false,
        text: provider,
      })
      if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => dispose, `yukari-rules:${name}`)
      }
    } catch (error) {
      // A duplicate registration on hot reload is not fatal: the backstop still
      // injects, and the warning names the reason.
      ctx.logger?.warn?.(`yukari-rules: 注入段注册失败 (${name}): ${messageOf(error)}`)
    }
  }

  registerSection(RULES_SECTION, RULES_ORDER, (context) => {
    try {
      const built = build(context)
      if (built.rendered.head === '') return ''
      record(context, built)
      return built.rendered.head
    } catch (error) {
      warnOnce('head', error)
      return ''
    }
  })

  registerSection(RULES_ANCHOR_SECTION, ANCHOR_ORDER, (context) => {
    try {
      return build(context).rendered.anchor
    } catch (error) {
      warnOnce('anchor', error)
      return ''
    }
  })

  try {
    const dispose = installBackstop(ctx.systemPrompt, buildTracked, ctx.logger)
    if (dispose !== null && typeof dispose === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => () => dispose(), 'yukari-rules:backstop')
    }
  } catch (error) {
    ctx.logger?.warn?.(`yukari-rules: 后备包装失败: ${messageOf(error)}`)
  }

  /* ------------------------------------------------------------------ panel */

  function scopeOf(value) {
    if (value === 'global' || value === 'workspace') return value
    throw appError('scope 必须是 global 或 workspace', 'rules-scope-invalid')
  }

  function workspaceOf(id) {
    const text = typeof id === 'string' ? id : ''
    const found = workspaces().find((workspace) => workspace.id === text)
    if (found === undefined) throw appError('未知工作区', 'rules-workspace-unknown')
    return found
  }

  function globalPayload() {
    const doc = cache.read(globalPath, DOC_LIMIT)
    return {
      scope: 'global',
      path: globalPath,
      exists: doc.exists,
      text: doc.text,
      bytes: doc.bytes,
      truncated: doc.truncated,
      // 面板显示的上限（DOC_LIMIT）与注入上限（maxBytes）不是一回事：一份 20 KB 的
      // rules.md 面板能看到全文，发给模型时却只到 16 KB。这里把注入侧的事实一并交代。
      injected: { truncated: doc.bytes > maxBytes, bytes: doc.bytes },
      mtimeMs: doc.mtimeMs,
    }
  }

  function workspacePayload(id) {
    const workspace = workspaceOf(id)
    const file = workspaceFile(workspace.path)
    const realRoot = realPathOf(workspace.path)
    const realFile = realPathOf(file)
    if (realFile !== null && realRoot !== null && !isInside(realRoot, realFile)) {
      throw new Error('rules.md 指向工作区外')
    }
    const doc = cache.read(file, DOC_LIMIT)
    return {
      scope: 'workspace',
      id: workspace.id,
      path: file,
      exists: doc.exists,
      text: doc.text,
      bytes: doc.bytes,
      truncated: doc.truncated,
      injected: { truncated: doc.bytes > maxBytes, bytes: doc.bytes },
      mtimeMs: doc.mtimeMs,
    }
  }

  function docPayload(scopeValue, id) {
    const scope = scopeOf(scopeValue)
    return scope === 'global' ? globalPayload() : workspacePayload(id)
  }

  function inspectWorkspace(workspace) {
    const file = workspaceFile(workspace.path)
    let dirExists = false
    try {
      dirExists = fs.statSync(workspace.path).isDirectory()
    } catch {
      dirExists = false
    }
    const info = inspectDoc(file)
    return {
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      filePath: file,
      dirExists,
      exists: info.exists,
      bytes: info.bytes,
      mtimeMs: info.mtimeMs,
    }
  }

  function snapshot() {
    const list = workspaces()
    return {
      ok: true,
      global: (() => {
        const info = inspectDoc(globalPath)
        return { path: globalPath, exists: info.exists, bytes: info.bytes, mtimeMs: info.mtimeMs }
      })(),
      workspaces: list.map(inspectWorkspace),
      // 注册表不可用时注入侧会退回 process.cwd()，面板必须能看见这次替换。
      workspacesDegraded,
      settings: { ...settings },
      limits: { maxBytes, docLimit: DOC_LIMIT },
      stats: {
        assembled: stats.assembled,
        globalHits: stats.globalHits,
        projectHits: stats.projectHits,
        bytes: stats.bytes,
        sessions: sessions.size,
        lastAt: stats.lastAt,
        recent: stats.recent.slice(-5),
      },
    }
  }

  /* ---------------------------------------------------------------- self-check */

  async function probe(sessionId) {
    const agents = serviceOf(ctx, 'agents')
    if (!agents || typeof agents.list !== 'function') return { ok: false, reason: 'no-agents' }
    const live = [...agents.list()]
    const target =
      typeof sessionId === 'string' && sessionId !== '' ? sessionId : (stats.recent.at(-1)?.session ?? '')

    let agent = null
    if (target === '') {
      agent = live.find((entry) => typeof entry?.session?.id === 'string' && entry.session.id !== '') ?? null
      if (agent === null) return { ok: false, reason: 'no-session' }
    } else {
      agent =
        live.find(
          (entry) => entry?.session?.id === target || entry?.id === target || shortId(entry?.session?.id) === target,
        ) ?? null
      if (agent === null) return { ok: false, reason: 'not-live', sessionId: target }
    }

    let assembly = null
    probing = true
    try {
      assembly = await ctx.systemPrompt.assemble({ agent })
    } catch (error) {
      return { ok: false, reason: messageOf(error) }
    } finally {
      probing = false
    }

    const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
    const names = sections.map((section) => String(section?.name ?? ''))
    const textOf = (name) =>
      sections
        .filter((section) => section?.name === name)
        .map((section) => String(section?.text ?? ''))
        .join('\n')
    const built = build({ agent })
    return {
      ok: true,
      sessionId: shortId(agent.session?.id ?? target),
      hasHead: names.includes(RULES_SECTION) && textOf(RULES_SECTION) !== '',
      hasAnchor: names.includes(RULES_ANCHOR_SECTION) && textOf(RULES_ANCHOR_SECTION) !== '',
      sections: names.slice(0, 12),
      bytes: built.rendered.bytes,
      globalPath,
      projectPath: built.scope.file,
      workspace:
        built.scope.workspace === null
          ? null
          : {
              id: built.scope.workspace.id,
              title: built.scope.workspace.title,
              path: built.scope.workspace.path,
            },
      truncated: { global: built.globalDoc?.truncated === true, project: built.projectDoc?.truncated === true },
    }
  }

  /* ---------------------------------------------------------------- http api */

  function resolveTarget(body) {
    const scope = scopeOf(body.scope)
    if (scope === 'global') return { scope, file: globalPath, root: null, id: undefined }
    const workspace = workspaceOf(body.id)
    return { scope, file: workspaceFile(workspace.path), root: workspace.path, id: workspace.id }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: guardRoute(ctx, async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')

          // GET /rules/api/config
          if (req.method === 'GET' && (action === 'config' || action === '')) {
            sendJson(res, 200, snapshot())
            return
          }

          // GET /rules/api/doc?scope=global|workspace&id=…
          if (req.method === 'GET' && action === 'doc') {
            sendJson(res, 200, { ok: true, doc: docPayload(url.searchParams.get('scope'), url.searchParams.get('id')) })
            return
          }

          // POST /rules/api/doc
          if (req.method === 'POST' && action === 'doc') {
            const body = await readJsonBody(req, BODY_LIMITS.large)
            const text = typeof body.text === 'string' ? body.text : ''
            const size = Buffer.byteLength(text, 'utf8')
            if (size > maxBytes) throw appError(`约束有 ${size} 字节，超过单份上限 ${maxBytes} 字节`, 'rules-too-large', { size, limit: maxBytes })
            const target = resolveTarget(body)
            assertWritable(target.file, target.root === null ? { ensureDir: true } : { root: target.root })
            writeDoc(target.file, text)
            cache.invalidate(target.file)
            sendJson(res, 200, {
              ok: true,
              doc:
                target.scope === 'global' ? globalPayload() : workspacePayload(target.id),
            })
            return
          }

          // POST /rules/api/reset
          if (req.method === 'POST' && action === 'reset') {
            const body = await readJsonBody(req, BODY_LIMITS.small)
            const target = resolveTarget(body)
            if (target.root !== null) {
              try {
                fs.statSync(target.root)
              } catch {
                throw appError('工作区目录不存在', 'rules-workspace-missing')
              }
            }
            removeDoc(target.file)
            cache.invalidate(target.file)
            sendJson(res, 200, {
              ok: true,
              doc:
                target.scope === 'global' ? globalPayload() : workspacePayload(target.id),
            })
            return
          }

          // POST /rules/api/settings
          if (req.method === 'POST' && action === 'settings') {
            const body = await readJsonBody(req, BODY_LIMITS.small)
            const switches = pickSwitches(body)
            try {
              settings = writeSettings(settingsPath, switches, settings)
            } catch (error) {
              // 回 200 会让面板把勾选态当成已保存，重启后却又变回去。保持内存状态
              // 与磁盘一致，把失败原样交给客户端。
              const failure = new Error(`开关保存失败：${messageOf(error)}`)
              failure.status = 500
              throw failure
            }
            sendJson(res, 200, { ok: true, settings: { ...settings } })
            return
          }

          // GET /rules/api/import?scope=…&id=…
          if (req.method === 'GET' && action === 'import') {
            const scope = scopeOf(url.searchParams.get('scope'))
            const workspace = scope === 'workspace' ? workspaceOf(url.searchParams.get('id')) : null
            const candidates = importCandidates(scope, {
              home: dshHome,
              agentsHome,
              root: workspace?.path ?? null,
            })
            const found = []
            let source = null
            let text = ''
            for (const file of candidates) {
              const doc = cache.read(file, DOC_LIMIT)
              found.push({ path: file, exists: doc.exists, bytes: doc.bytes })
              if (source === null && doc.exists && doc.text.trim() !== '') {
                source = file
                text = doc.text
              }
            }
            sendJson(res, 200, { ok: true, source, text, candidates: found })
            return
          }

          // GET /rules/api/probe[?sessionId=…]
          if (req.method === 'GET' && action === 'probe') {
            // 包一层信封：`ok: false` 在协议里是"请求失败"，而自检答"没有可检查的
            // 会话"是一次成功的查询。直接把它当信封发出去，面板会显示 HTTP 200。
            sendJson(res, 200, { ok: true, probe: await probe(url.searchParams.get('sessionId')) })
            return
          }

          sendJson(res, 404, { ok: false, error: 'not found' })
        }),
      }),
    `yukari-rules: ${API_PATH}/*`,
  )
}
