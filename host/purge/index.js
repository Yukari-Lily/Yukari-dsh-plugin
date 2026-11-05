/**
 * Yukari Purge Module: Unrestricted Mode (无限制模式).
 *
 * Provides:
 * 1. Dual registration of the 'unrestricted' preset into DSH.
 * 2. Non-intrusive prompt assembly hook and guard that activates ONLY when the session's
 *    preset is 'unrestricted'. Standard and other modes are passed through 100% untouched.
 * 3. REST API for viewing, editing, and resetting the purge prompt from the Yukari UI.
 *
 * @module @local/yukari-purge
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PURGE_PROMPT } from './lib/default-prompt.js'
import { ensurePresetFiles, registerPresetService, UNRESTRICTED_PRESET_ID } from './lib/preset.js'
import { rewritePromptAssembly } from './lib/rewriter.js'

export const API_PATH = '/purge/api'
const MAX_BODY_BYTES = 128 * 1024

/** Services this plugin needs */
export const inject = ['systemPrompt', 'webServer', 'connection']

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return path.normalize(fromEnv.trim())
  return path.normalize(path.join(os.homedir(), '.dsh'))
}

function promptFilePath(dshHome) {
  return path.join(dshHome, 'yukari-purge-prompt.md')
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const val = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return val !== null && typeof val === 'object' ? val : {}
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/**
 * Install the assembly guard on ctx.systemPrompt.assemble.
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
    if (typeof slot.rewrite === 'function') {
      const context = args[0]
      return slot.rewrite(assembled, context)
    }
    return assembled
  }

  wrapped._yukariPurgeWrapped = true
  wrapped._yukariPurgeSlot = slot

  try {
    promptHost.assemble = wrapped
  } catch {
    // If property is read-only, we fallback to event listener
  }

  return () => {
    slot.rewrite = null
    if (promptHost.assemble === wrapped) {
      promptHost.assemble = original
    }
  }
}

export function apply(ctx, config = {}) {
  const dshHome = resolveDshHome()
  const customFile = promptFilePath(dshHome)

  let activePrompt = DEFAULT_PURGE_PROMPT
  let isCustom = false

  try {
    if (fs.existsSync(customFile)) {
      const saved = fs.readFileSync(customFile, 'utf8')
      if (saved && saved.trim()) {
        activePrompt = saved
        isCustom = true
      }
    }
  } catch {
    activePrompt = DEFAULT_PURGE_PROMPT
  }

  // 1. Ensure bundled preset files are on disk and register with agentPresets
  ensurePresetFiles(dshHome)
  const unregisterPreset = registerPresetService(ctx)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => unregisterPreset(), 'yukari-purge:preset')
  }

  // 2. Setup assembly rewriter
  const rewriteFn = (assembled, context) => {
    return rewritePromptAssembly(assembled, context, activePrompt)
  }

  // Hook via system-prompt/assemble event (Cordis waterfall)
  try {
    ctx.on(
      'system-prompt/assemble',
      async (...args) => {
        const [assembly, context] = args
        const next = args.length >= 3 ? args[args.length - 1] : null
        let assembled = assembly
        if (typeof next === 'function') {
          try {
            assembled = await next()
          } catch {
            assembled = assembly
          }
        }
        return rewriteFn(assembled, context)
      },
      { global: true, prepend: true },
    )
  } catch {}

  // Guard via ctx.systemPrompt.assemble method wrapping
  try {
    const guardDisposer = installAssembleGuard(ctx.systemPrompt, rewriteFn)
    if (guardDisposer && typeof ctx.effect === 'function') {
      ctx.effect(() => () => guardDisposer(), 'yukari-purge:guard')
    }
  } catch {}

  // 3. Register HTTP API for Web panel
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: async (req, res) => {
          const rejection = ctx.connection.requestRejection(req)
          if (rejection !== undefined && rejection !== null) {
            res.statusCode = rejection
            res.end()
            return
          }

          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')

          try {
            // GET /purge/api/config
            if (req.method === 'GET' && (action === 'config' || action === '')) {
              sendJson(res, 200, {
                ok: true,
                presetId: UNRESTRICTED_PRESET_ID,
                presetName: '无限制模式',
                isCustom,
                prompt: activePrompt,
                defaultPrompt: DEFAULT_PURGE_PROMPT,
              })
              return
            }

            // POST /purge/api/config
            if (req.method === 'POST' && action === 'config') {
              const body = await readJsonBody(req)
              if (typeof body.prompt === 'string') {
                activePrompt = body.prompt
                isCustom = true
                try {
                  fs.writeFileSync(customFile, activePrompt, 'utf8')
                } catch (writeErr) {
                  // If disk write fails, in-memory still active
                  ctx.logger?.warn?.('yukari-purge: 保存提示词到磁盘失败: %s', writeErr?.message)
                }
                sendJson(res, 200, { ok: true, isCustom: true, prompt: activePrompt })
                return
              }
              sendJson(res, 400, { ok: false, error: 'prompt must be a string' })
              return
            }

            // POST /purge/api/reset
            if (req.method === 'POST' && action === 'reset') {
              activePrompt = DEFAULT_PURGE_PROMPT
              isCustom = false
              try {
                if (fs.existsSync(customFile)) {
                  fs.unlinkSync(customFile)
                }
              } catch {}
              sendJson(res, 200, {
                ok: true,
                isCustom: false,
                prompt: activePrompt,
                defaultPrompt: DEFAULT_PURGE_PROMPT,
              })
              return
            }

            sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err?.message || String(err) })
          }
        },
      }),
    `yukari: ${API_PATH}/*`,
  )
}
