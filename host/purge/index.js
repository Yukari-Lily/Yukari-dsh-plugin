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
import { migratePath } from '../shared/migrate.js'
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
import { createRetryGate } from './lib/retry-gate.js'
import { pickSwitches, readSettings, writeSettings } from './lib/settings.js'
import { installStreamRetry } from './lib/stream-retry.js'

export const API_PATH = '/purge/api'
/** Services this plugin needs */
export const inject = ['agentPresets', 'systemPrompt', 'webServer', 'connection']

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

export function apply(ctx, config = {}) {
  markMounted(ctx, 'purge')

  const dshHome = resolveDshHome()
  const promptFile = path.join(dshHome, 'purge-prompt.md')
  const settingsFile = path.join(dshHome, 'purge-settings.json')
  // Older versions prefixed every file with `yukari-`; move them once so an
  // upgrade keeps the edited prompt and the switches.
  migratePath(path.join(dshHome, 'yukari-purge-prompt.md'), promptFile)
  migratePath(path.join(dshHome, 'yukari-purge-settings.json'), settingsFile)

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

  /** Why the preset could not be registered, when it could not. */
  let presetError = null
  let presetRegistered = false
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
  /** 改写器见过的会话；门闸只对其中仍然有效的条目作答。 */
  const gate = createRetryGate()
  /** Set while the self-check runs its own assembly. */
  let probing = false

  function noteSession(context) {
    // A self-check assembles a real session; it must not move the numbers it reports.
    if (probing) return
    if (!gate.note(context)) return
    const id = (context?.agent?.session ?? context?.session).id
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

  // Tail section: 10250 clears every host section (highest is 10200). The rules
  // component puts its own tail reminder at 10400 on top of this, which is the
  // intended order: the operator's own last word outranks the mode's anchor.
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

  // 预设切换与智能体销毁都让门闸立刻失效：标准模式下的拒答不能再被拦截。
  try {
    ctx.on('agent-preset/selected', (sessionId) => gate.forget(sessionId), { global: true })
    ctx.on(
      'agent/disposed',
      ({ agent } = {}) => gate.forget(agent?.session?.id),
      { global: true },
    )
  } catch (error) {
    ctx.logger?.warn?.('yukari-purge: 会话清理监听注册失败: %s', error?.message ?? error)
  }

  // The listener is owned by our fiber, so it unloads with the plugin.
  installStreamRetry(ctx, {
    allowed: (request) => settings.refusalRetry && gate.isEligible(request.sessionId),
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
    const textOf = (name) =>
      (assembly?.sections ?? [])
        .filter((section) => section?.name === name)
        .map((section) => String(section?.text ?? ''))
        .join('\n')
    return {
      ok: true,
      sessionId: shortId(agent.session?.id ?? target),
      hasInject: names.includes(PURGE_SECTION) && textOf(PURGE_SECTION).includes(SENTINEL),
      // 标准模式与会话不匹配时这一段注册着但文本为空，只看段名会把「没有」报成「在」。
      hasAnchor: textOf(ANCHOR_SECTION) !== '',
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
      presetRegistered,
      presetError,
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
        sessions: gate.size,
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
            // 包一层信封：`ok: false` 在协议里是"请求失败"，而自检答"没有可检查的
            // 会话"是一次成功的查询。直接把它当信封发出去，面板会显示 HTTP 200。
            sendJson(res, 200, { ok: true, probe: await probe(url.searchParams.get('sessionId')) })
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

  // Registered last and deliberately not awaited: `register()` mounts the
  // preset's whole row list, and the loader waits for every plugin body to
  // settle at boot. Awaiting it here would put that mount on the boot path —
  // and one slow row would hold the Host's settle open. The seams above are
  // already mounted synchronously, so the mode appears a tick later instead.
  ctx.effect(() => {
    let release = null
    let disposed = false
    const warn = (error) => {
      const message = String(error?.message ?? error)
      // A second mount (hot reload) reports the existing registration; not an error.
      if (/already|duplicate/i.test(message)) {
        presetRegistered = true
        presetError = null
        return
      }
      presetError = message
      ctx.logger?.warn?.('yukari-purge: 注册预设失败: %s', message)
    }
    void Promise.resolve()
      .then(() => ctx.agentPresets.register(getPresetDefinition()))
      .then(
        (disposer) => {
          if (disposed) {
            void disposer?.()
            return
          }
          release = disposer
          presetRegistered = true
          presetError = null
          ctx.logger?.info?.('yukari-purge: 已注册预设 [无限制模式]')
        },
        warn,
      )
      .catch(warn)
    return () => {
      disposed = true
      const disposer = release
      release = null
      if (typeof disposer === 'function') {
        try {
          void disposer()
        } catch (error) {
          warn(error)
        }
      }
    }
  }, 'yukari-purge:preset')
}
