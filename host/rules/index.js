/**
 * Yukari Rules: operator constraints, injected as system prompt text.
 *
 * Two files hold the whole state:
 * - `$DSH_HOME/rules.md` applies to every session;
 * - `<project root>/rules.md` applies to the sessions working under it.
 *
 * The text is rendered twice (head at -950, tail anchor at 10400) so it stays
 * binding after a long conversation, and the files are re-read on every
 * assembly, so a save or an external edit applies to the next model step
 * without a restart.
 *
 * The panel edits the same files through `/rules/api`, which is why the
 * injection path never trusts a request for a directory: reads and writes are
 * resolved against the workspace registry and confined to the two fixed files.
 * @module yukari-dsh-plugin/rules
 */
import fs from 'node:fs'
import path from 'node:path'
import { markMounted } from '../shared/mounted.js'
import { BODY_LIMITS, guardRoute, messageOf, readJsonBody, sendJson } from '../shared/http.js'
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

/** Whether an assembly belongs to a delegated child. */
function isSubagentContext(context) {
  const header = sessionOf(context)?.header
  if (!header) return false
  return (
    header.origin === 'subagent' ||
    (Number.isInteger(header.delegationDepth) && header.delegationDepth > 0) ||
    Boolean(header.parentSession)
  )
}

/**
 * Install the assemble() backstop.
 *
 * Registry sections are the primary seam, but a `complete: true` section is
 * restored after the assembly waterfall and would drop them. The wrapper is the
 * only place that sees that finished assembly.
 */
function installBackstop(promptHost, build, logger) {
  if (!promptHost || typeof promptHost.assemble !== 'function') return null
  const original = promptHost.assemble
  if (original._yukariRulesWrapped) {
    // A hot reload replaced the row: keep the one wrapper, point it at the new state.
    if (original._yukariRulesSlot) original._yukariRulesSlot.build = build
    return () => {}
  }

  const slot = { build }
  const wrapped = async function assembleWithRules(...args) {
    const assembled = await original.apply(promptHost, args)
    try {
      return ensureSections(assembled, args[0], slot.build)
    } catch (error) {
      logger?.warn?.(`yukari-rules: 后备注入失败: ${messageOf(error)}`)
      return assembled
    }
  }
  wrapped._yukariRulesWrapped = true
  wrapped._yukariRulesSlot = slot

  try {
    promptHost.assemble = wrapped
  } catch {
    return null
  }

  return () => {
    if (promptHost.assemble === wrapped) promptHost.assemble = original
  }
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
    const scope = resolveScope(ctx, session)
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
    throw new Error('scope 必须是 global 或 workspace')
  }

  function workspaceOf(id) {
    const text = typeof id === 'string' ? id : ''
    const found = workspaceList(ctx).find((workspace) => workspace.id === text)
    if (found === undefined) throw new Error('未知工作区')
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
    return {
      ok: true,
      global: (() => {
        const info = inspectDoc(globalPath)
        return { path: globalPath, exists: info.exists, bytes: info.bytes, mtimeMs: info.mtimeMs }
      })(),
      workspaces: workspaceList(ctx).map(inspectWorkspace),
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
            if (size > maxBytes) throw new Error(`约束有 ${size} 字节，超过单份上限 ${maxBytes} 字节`)
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
                throw new Error('工作区目录不存在')
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
              settings = { ...settings, ...switches }
              warnOnce('settings', error)
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
            sendJson(res, 200, await probe(url.searchParams.get('sessionId')))
            return
          }

          sendJson(res, 404, { ok: false, error: 'not found' })
        }),
      }),
    `yukari-rules: ${API_PATH}/*`,
  )
}
