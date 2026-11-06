/**
 * Yukari Purge Module: Unrestricted Mode (无限制模式).
 *
 * Four layers, each addressing one reason a mode like this normally disappoints:
 *
 * 1. Prompt    — a head section with the operator contract and a tail section
 *                (order 10250, after every host section) that survives long
 *                contexts. A delegated child gets its own anchor context, placed
 *                after the host's delegation notice.
 * 2. Language  — host sentences that teach the model to give up ("do not retry
 *                another way", "state the limitation") are rewritten in place,
 *                including the shell tool declarations only an assemble wrapper
 *                can reach.
 * 3. Retry     — a refusal that still happens is discarded and the request is
 *                reissued once with a closing instruction.
 * 4. Proof     — every seam records what it did, and `GET /purge/api/probe`
 *                assembles one live session on demand so the panel can show
 *                whether the injection really reached the prompt.
 *
 * @module @local/yukari-purge
 */
import fs from 'node:fs'
import path from 'node:path'
import { markMounted } from '../shared/mounted.js'
import { resolveDshHome } from '../shared/home.js'
import { BODY_LIMITS, guardRoute, readJsonBody, sendJson } from '../shared/http.js'
import { ANCHOR_TEXT, CHILD_ANCHOR_TEXT, DEFAULT_PROMPT, SENTINEL } from './lib/prompts.js'
import { ensurePresetFiles, getPresetDefinition, UNRESTRICTED_PRESET_ID } from './lib/preset.js'
import {
  ANCHOR_SECTION,
  CHILD_ANCHOR_CONTEXT,
  PURGE_SECTION,
  isSubagentContext,
  isUnrestrictedSession,
  rewritePromptAssembly,
  scrubTools,
} from './lib/rewriter.js'
import { pickSwitches, readSettings, writeSettings } from './lib/settings.js'
import { installStreamRetry } from './lib/stream-retry.js'

export const API_PATH = '/purge/api'
/** Services this plugin needs */
export const inject = ['agentPresets', 'systemPrompt', 'webServer', 'connection']

/** How many sessions the retry gate remembers. */
const SESSION_CAP = 500
/** How many recent rewrites the panel can show. */
const RECENT_CAP = 20

function shortId(id) {
  const text = typeof id === 'string' ? id : ''
  return text.length > 10 ? text.slice(0, 10) : text
}

/**
 * Wrap `ctx.systemPrompt.assemble`.
 *
 * This is the only seam that sees the finished assembly (a `complete` section
 * replaces the waterfall's section list afterwards) and the only one that sees
 * tool declarations. It may not be the instance a given agent loop calls, so it
 * is a backstop rather than the primary injection path.
 */
function installAssembleGuard(promptHost, rewriteFn) {
  if (!promptHost || typeof promptHost.assemble !== 'function') return null
  const original = promptHost.assemble
  if (original._yukariPurgeWrapped) {
    original._yukariPurgeSlot.rewrite = rewriteFn
    return () => {}
  }

  const slot = { rewrite: rewriteFn }
  const origBound = original.bind(promptHost)

  const wrapped = async function assembleWithPurge(...args) {
    const assembled = await origBound(...args)
    if (typeof slot.rewrite !== 'function') return assembled
    return slot.rewrite(assembled, args[0])
  }

  wrapped._yukariPurgeWrapped = true
  wrapped._yukariPurgeSlot = slot

  try {
    promptHost.assemble = wrapped
  } catch {
    return null
  }

  return () => {
    slot.rewrite = null
    if (promptHost.assemble === wrapped) promptHost.assemble = original
  }
}

export async function apply(ctx, config = {}) {
  markMounted(ctx, 'purge')

  const dshHome = resolveDshHome()
  const promptFile = path.join(dshHome, 'yukari-purge-prompt.md')
  const settingsFile = path.join(dshHome, 'yukari-purge-settings.json')

  let settings = readSettings(settingsFile, config)
  let promptText = DEFAULT_PROMPT
  let isCustom = false

  try {
    if (fs.existsSync(promptFile)) {
      const saved = fs.readFileSync(promptFile, 'utf8')
      if (saved.trim()) {
        promptText = saved
        isCustom = true
      }
    }
  } catch {
    promptText = DEFAULT_PROMPT
  }

  /* ----------------------------------------------------------- observability */

  const stats = {
    assembled: 0,
    injected: 0,
    stripped: 0,
    scrubbed: 0,
    tools: 0,
    retried: 0,
    skipped: 0,
    lastAt: null,
    recent: [],
  }
  /** Session ids seen by the rewriter; the retry gate only answers for these. */
  const sessions = new Map()
  /** Set while the self-check runs its own assembly. */
  let probing = false

  function noteSession(context) {
    // A self-check assembles a real session; it must not move the numbers it reports.
    if (probing) return
    const session = context?.agent?.session ?? context?.session
    const id = session?.id
    if (typeof id !== 'string' || id === '') return
    if (!sessions.has(id) && sessions.size >= SESSION_CAP) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }
    sessions.set(id, { at: Date.now(), sub: isSubagentContext(context) })
    stats.assembled += 1
    stats.lastAt = new Date().toISOString()
    stats.recent.push({
      at: stats.lastAt,
      session: shortId(id),
      origin: isSubagentContext(context) ? 'subagent' : 'main',
    })
    if (stats.recent.length > RECENT_CAP) stats.recent.splice(0, stats.recent.length - RECENT_CAP)
  }

  function noteRewrite(counts) {
    if (counts.injected) stats.injected += 1
    stats.stripped += counts.stripped
    stats.scrubbed += counts.scrubbed
  }

  function noteRetry(entry) {
    if (entry?.event === 'retried') stats.retried += 1
    if (entry?.event === 'skipped') stats.skipped += 1
  }

  /* ---------------------------------------------------------------- rewriting */

  const anchorText = () => (settings.anchor ? ANCHOR_TEXT : '')

  /** Options for one assembly; `prompt` and `anchorText` re-evaluate per call. */
  function rewriteOptions(context) {
    return {
      prompt: promptText,
      anchorText: anchorText(),
      strip: settings.stripHostLimits,
      onActive: noteSession,
      onStats: noteRewrite,
    }
  }

  /** Sections + scrubbing for one assembly. */
  function rewriteAssembly(assembled, context) {
    try {
      return rewritePromptAssembly(assembled, context, rewriteOptions(context))
    } catch (error) {
      ctx.logger?.warn?.('yukari-purge: 组装改写失败: %s', error?.message ?? error)
      return assembled
    }
  }

  /** The wrapper's extra duty: tool declarations (and the `complete` backstop). */
  function rewriteFull(assembled, context) {
    const rewritten = rewriteAssembly(assembled, context)
    if (!isUnrestrictedSession(context) || !settings.stripHostLimits) return rewritten
    if (!rewritten || !Array.isArray(rewritten.tools)) return rewritten
    try {
      const { tools, changed } = scrubTools(rewritten.tools)
      if (changed === 0) return rewritten
      stats.tools += changed
      return { ...rewritten, tools }
    } catch {
      return rewritten
    }
  }

  /* ---------------------------------------------------------------- preset + prompt */

  ensurePresetFiles(dshHome)
  // `agentPresets` is declared in `inject`, so the registry exists by the time
  // apply runs: register once and let the effect own the release.
  let releasePreset = null
  try {
    releasePreset = await ctx.agentPresets.register(getPresetDefinition())
    ctx.logger?.info?.('yukari-purge: 已注册预设 [无限制模式]')
  } catch (error) {
    const message = String(error?.message ?? error)
    // A second mount (hot reload) reports the existing registration; not an error.
    if (!/already|duplicate/i.test(message)) ctx.logger?.warn?.('yukari-purge: 注册预设失败: %s', message)
  }
  if (typeof releasePreset === 'function') {
    ctx.effect(() => () => releasePreset(), 'yukari-purge:preset')
  }

  // Head section: the operator contract. Empty for every other preset.
  try {
    const dispose = ctx.systemPrompt?.section?.({
      name: PURGE_SECTION,
      order: -900,
      interpolate: false,
      text: (context) => (isUnrestrictedSession(context) ? promptText : ''),
    })
    if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, 'yukari-purge:section')
    }
  } catch (error) {
    ctx.logger?.warn?.('yukari-purge: 注入段注册失败: %s', error?.message ?? error)
  }

  // Tail section: 10250 sits above every host section (highest is 10200), so it
  // is the last thing the model reads before the tool declarations.
  try {
    const dispose = ctx.systemPrompt?.section?.({
      name: ANCHOR_SECTION,
      order: 10250,
      interpolate: false,
      text: (context) => (isUnrestrictedSession(context) && settings.anchor ? ANCHOR_TEXT : ''),
    })
    if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, 'yukari-purge:anchor')
    }
  } catch (error) {
    ctx.logger?.warn?.('yukari-purge: 尾部锚点注册失败: %s', error?.message ?? error)
  }

  // Child anchor: after the host's `subagent:delegation` context (order 120),
  // which otherwise tells a delegated child to report the limitation and stop.
  try {
    const dispose = ctx.systemPrompt?.context?.({
      name: CHILD_ANCHOR_CONTEXT,
      order: 235,
      required: true,
      interpolate: false,
      text: (context) =>
        isUnrestrictedSession(context) && settings.anchor && isSubagentContext(context) ? CHILD_ANCHOR_TEXT : '',
    })
    if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, 'yukari-purge:child-anchor')
    }
  } catch (error) {
    ctx.logger?.warn?.('yukari-purge: 子会话锚点注册失败: %s', error?.message ?? error)
  }

  // Primary seam: the assemble waterfall. Always dispatched, scope-independent.
  try {
    ctx.on(
      'system-prompt/assemble',
      async (...args) => {
        const assembly = args[0]
        const context = args[1]
        const next = args.length >= 3 && typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
        let current = assembly
        if (next) {
          try {
            current = await next()
          } catch (error) {
            ctx.logger?.warn?.('yukari-purge: 下游组装抛错，按原样继续: %s', error?.message ?? error)
            current = assembly
          }
        }
        return rewriteAssembly(current, context)
      },
      { global: true, prepend: true },
    )
  } catch (error) {
    ctx.logger?.warn?.('yukari-purge: 瀑布钩子挂载失败: %s', error?.message ?? error)
  }

  // Backstop seam: the assemble wrapper.
  try {
    const guardDisposer = installAssembleGuard(ctx.systemPrompt, rewriteFull)
    if (guardDisposer && typeof ctx.effect === 'function') {
      ctx.effect(() => () => guardDisposer(), 'yukari-purge:guard')
    }
  } catch (error) {
    ctx.logger?.warn?.('yukari-purge: assemble 包装失败: %s', error?.message ?? error)
  }

  /* -------------------------------------------------------------------- retry */

  const llmService = () => {
    try {
      const direct = ctx.llm
      if (direct && typeof direct.stream === 'function') return direct
    } catch {
      /* proxy without the service yet */
    }
    try {
      const scoped = typeof ctx.get === 'function' ? ctx.get('llm') : null
      if (scoped && typeof scoped.stream === 'function') return scoped
    } catch {
      /* ignore */
    }
    return null
  }

  // The listener is owned by our fiber, so it unloads with the plugin.
  installStreamRetry(ctx, {
    allowed: (sessionId) => settings.refusalRetry && typeof sessionId === 'string' && sessions.has(sessionId),
    reissue: (request) => {
      const llm = llmService()
      if (!llm) throw new Error('llm service unavailable')
      return llm.stream(request)
    },
    report: noteRetry,
  })

  /* ---------------------------------------------------------------- self-check */

  /**
   * Assemble one live session and report what came back — the difference between
   * "we think we injected" and "the prompt really carries it".
   */
  async function probe(sessionId) {
    const agents = (() => {
      try {
        const direct = ctx.agents
        if (direct && typeof direct.get === 'function') return direct
      } catch {
        /* ignore */
      }
      try {
        return typeof ctx.get === 'function' ? ctx.get('agents') : null
      } catch {
        return null
      }
    })()
    if (!agents || typeof agents.get !== 'function') return { ok: false, reason: 'no-agents' }

    const target = typeof sessionId === 'string' && sessionId !== '' ? sessionId : stats.recent.at(-1)?.session ?? ''
    if (target === '') return { ok: false, reason: 'no-session' }

    const agent = [...(typeof agents.list === 'function' ? agents.list() : [])].find(
      (entry) => entry?.session?.id === target || entry?.id === target || shortId(entry?.session?.id) === target,
    )
    if (!agent) return { ok: false, reason: 'not-live', sessionId: target }

    let assembly = null
    probing = true
    try {
      assembly = await ctx.systemPrompt.assemble({ agent })
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    } finally {
      probing = false
    }
    const names = (assembly?.sections ?? []).map((section) => String(section?.name ?? ''))
    const text = (assembly?.sections ?? []).map((section) => String(section?.text ?? '')).join('\n')
    return {
      ok: true,
      sessionId: shortId(agent.session?.id ?? target),
      hasInject: names.includes(PURGE_SECTION) && text.includes(SENTINEL),
      hasAnchor: names.includes(ANCHOR_SECTION),
      anchorBytes: settings.anchor ? ANCHOR_TEXT.length : 0,
      sections: names.slice(0, 12),
      tools: Array.isArray(assembly?.tools) ? assembly.tools.length : 0,
    }
  }

  /* ---------------------------------------------------------------- http api */

  function snapshot() {
    return {
      ok: true,
      presetId: UNRESTRICTED_PRESET_ID,
      presetName: '无限制模式',
      isCustom,
      prompt: promptText,
      defaultPrompt: DEFAULT_PROMPT,
      settings: { ...settings },
      stats: {
        assembled: stats.assembled,
        injected: stats.injected,
        stripped: stats.stripped,
        scrubbed: stats.scrubbed,
        tools: stats.tools,
        retried: stats.retried,
        skipped: stats.skipped,
        sessions: sessions.size,
        lastAt: stats.lastAt,
        recent: stats.recent.slice(-5),
      },
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: guardRoute(ctx, async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')

          // GET /purge/api/config
          if (req.method === 'GET' && (action === 'config' || action === '')) {
            sendJson(res, 200, snapshot())
            return
          }

          // GET /purge/api/probe[?sessionId=…]
          if (req.method === 'GET' && action === 'probe') {
            sendJson(res, 200, await probe(url.searchParams.get('sessionId')))
            return
          }

          // POST /purge/api/config
          if (req.method === 'POST' && action === 'config') {
            const body = await readJsonBody(req, BODY_LIMITS.large)
            if (typeof body.prompt === 'string') {
              promptText = body.prompt
              isCustom = true
              try {
                fs.writeFileSync(promptFile, promptText, 'utf8')
              } catch (writeError) {
                ctx.logger?.warn?.('yukari-purge: 保存提示词失败: %s', writeError?.message)
              }
            }
            const switches = pickSwitches(body)
            if (Object.keys(switches).length > 0) {
              try {
                settings = writeSettings(settingsFile, switches, settings)
              } catch (writeError) {
                settings = { ...settings, ...switches }
                ctx.logger?.warn?.('yukari-purge: 保存开关失败: %s', writeError?.message)
              }
            }
            sendJson(res, 200, snapshot())
            return
          }

          // POST /purge/api/reset
          if (req.method === 'POST' && action === 'reset') {
            promptText = DEFAULT_PROMPT
            isCustom = false
            try {
              if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile)
            } catch {
              /* a read-only home keeps the in-memory default */
            }
            sendJson(res, 200, snapshot())
            return
          }

          sendJson(res, 404, { ok: false, error: 'not found' })
        }),
      }),
    `yukari: ${API_PATH}/*`,
  )
}
