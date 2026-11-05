/**
 * Yukari — one bundle for the whole Harness control surface.
 *
 * Five capabilities that used to ship as five separate bundles now mount from
 * a single loader row and a single sidebar panel:
 *
 * - `host/chats`    stored-chat inventory, archive flag, permanent delete;
 * - `host/runtime`  version check, npm upgrade, in-place restart;
 * - `host/sites`    published static sites served under the web path;
 * - `host/proxy`    Shadowsocks egress for the whole process;
 * - `host/browser`  the headless Chromium the agent drives.
 *
 * Each host half keeps its own JSON API (`/chat-manager/api`, `/dshctl/api`,
 * `/publish/api`, `/ssproxy/api`) and its own agent tools, so the merged bundle
 * changes packaging and presentation only. This module mounts them and adds one
 * small read-only endpoint that the panel's overview tab uses.
 * @module yukari-dsh-plugin
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { apply as applyBrowser } from './host/browser/index.js'
import { apply as applyChats } from './host/chats/index.js'
import { apply as applyProxy } from './host/proxy/index.js'
import { apply as applyRuntime } from './host/runtime/index.js'
import { apply as applySites } from './host/sites/index.js'

const execFileAsync = promisify(execFile)
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

let suiteVersion = '1.3.0'
try {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  if (pkg.version) suiteVersion = String(pkg.version)
} catch {
  // fallback to default
}

/** Read-only endpoint the overview tab calls. */
export const API_PATH = '/yukari/api'

/** Services the merged bundle needs: the union of its five host halves. */
export const inject = ['tools', 'webServer', 'connection', 'sessionPersistence', 'sessionQuery', 'sessions']

/** Serialize one JSON response. */
function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/** Detect whether a usable Chromium binary exists on the system. */
function detectChromium(configuredPath) {
  if (typeof configuredPath === 'string' && configuredPath.trim() !== '') {
    return { path: configuredPath.trim(), ready: existsSync(configuredPath.trim()) }
  }
  for (const name of ['DSH_BROWSER_EXECUTABLE', 'CHROME_PATH', 'CHROMIUM_PATH']) {
    const val = process.env[name]
    if (val && existsSync(val)) return { path: val, ready: true }
  }
  const standardPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ]
  for (const p of standardPaths) {
    if (existsSync(p)) return { path: p, ready: true }
  }
  return { path: '未检测到 (需安装 chromium)', ready: false }
}

/** Section config with its defaults filled in, so the panel can show real values. */
function sections(config) {
  const browser = config.browser ?? {}
  const chats = config.chats ?? {}
  const runtime = config.runtime ?? {}
  const sites = config.sites ?? {}
  const proxy = config.proxy ?? {}
  const browserDetected = detectChromium(browser.executablePath)
  return {
    browser: {
      viewportWidth: Number(browser.viewportWidth) > 0 ? Number(browser.viewportWidth) : 1280,
      viewportHeight: Number(browser.viewportHeight) > 0 ? Number(browser.viewportHeight) : 900,
      settleMs: Number.isFinite(Number(browser.settleMs)) ? Number(browser.settleMs) : 300,
      headless: true,
      executable: browserDetected.path,
      ready: browserDetected.ready,
    },
    chats: {
      sessionsRoot: typeof chats.sessionsRoot === 'string' && chats.sessionsRoot !== '' ? chats.sessionsRoot : 'DSH_HOME/sessions',
    },
    runtime: {
      channel: typeof runtime.channel === 'string' && runtime.channel !== '' ? runtime.channel : process.env.DSH_CHANNEL ?? 'rc',
      restartMode: typeof runtime.restartMode === 'string' && runtime.restartMode !== '' ? runtime.restartMode : 'auto',
    },
    sites: {
      root: typeof sites.root === 'string' && sites.root !== '' ? sites.root : '/workspace/publish',
      publicBase: typeof sites.publicBase === 'string' && sites.publicBase !== '' ? sites.publicBase : 'http://127.0.0.1:3080/p',
      maxMb: Number(sites.maxMb) > 0 ? Number(sites.maxMb) : 200,
    },
    proxy: {
      localPort: Number(proxy.localPort) >= 1024 ? Number(proxy.localPort) : 17890,
      bypass: typeof proxy.bypass === 'string' && proxy.bypass !== '' ? proxy.bypass : 'localhost,127.0.0.1,::1',
    },
  }
}

/** Update the plugin from Git repository or package manager. */
async function runPluginUpdate() {
  // Method 1: If PLUGIN_DIR has a .git repository
  if (existsSync(path.join(PLUGIN_DIR, '.git'))) {
    try {
      const { stdout } = await execFileAsync('git', ['pull', 'origin', 'main'], {
        cwd: PLUGIN_DIR,
        timeout: 30000,
      })
      return { ok: true, restartRequired: true, message: stdout.trim() || 'Git pull 成功' }
    } catch (err) {
      // Fall through to other methods
    }
  }

  // Method 2: Try DSH CLI
  try {
    const { stdout } = await execFileAsync('dsh', ['plugin', 'add', 'git+https://github.com/Yukari-Lily/Yukari-dsh-plugin.git'], {
      timeout: 60000,
    })
    return { ok: true, restartRequired: true, message: stdout.trim() || 'DSH 插件更新成功' }
  } catch {
    // Fall through
  }

  // Method 3: Try pnpm in DSH profile directory
  try {
    const dshHome = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')
    const profileDir = path.join(dshHome, 'profiles', 'default')
    const cwd = existsSync(profileDir) ? profileDir : process.cwd()
    const { stdout } = await execFileAsync('pnpm', ['add', 'git+https://github.com/Yukari-Lily/Yukari-dsh-plugin.git'], {
      cwd,
      timeout: 60000,
    })
    return { ok: true, restartRequired: true, message: stdout.trim() || 'Pnpm 更新完成' }
  } catch (pnpmErr) {
    return { ok: false, restartRequired: false, error: pnpmErr.message }
  }
}

/**
 * Register the merged bundle.
 * @param ctx - plugin context.
 * @param config - `browser`, `chats`, `runtime`, `sites`, `proxy` sections.
 */
export function apply(ctx, config = {}) {
  const parts = sections(config ?? {})
  const root = ctx.root ?? ctx

  // Backward compatibility: If running under legacy single-row configuration where
  // sub-plugins were not mounted individually in cordis.patch.yml:
  if (!root['yukari.browser']) applyBrowser(ctx, config?.browser ?? {})
  if (!root['yukari.chats']) applyChats(ctx, config?.chats ?? {})
  if (!root['yukari.runtime']) applyRuntime(ctx, config?.runtime ?? {})
  if (!root['yukari.sites']) applySites(ctx, config?.sites ?? {})
  if (!root['yukari.proxy']) applyProxy(ctx, config?.proxy ?? {})

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

          if (action === 'update' && req.method === 'POST') {
            const result = await runPluginUpdate()
            sendJson(res, result.ok ? 200 : 500, result)
            return
          }

          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'use GET or POST /update' })
            return
          }
          try {
            sendJson(res, 200, {
              ok: true,
              overview: {
                version: suiteVersion,
                pid: process.pid,
                hostname: hostname(),
                at: new Date().toISOString(),
                parts,
                tools: [
                  'chat_inventory',
                  'chat_delete',
                  'dsh_runtime_status',
                  'dsh_check_update',
                  'dsh_update',
                  'dsh_restart',
                  'list_sites',
                  'publish_site',
                  'delete_site',
                  'ss_proxy',
                  'browser_open',
                  'browser_snapshot',
                  'browser_click',
                  'browser_type',
                  'browser_press',
                  'browser_scroll',
                  'browser_screenshot',
                  'browser_eval',
                  'browser_tabs',
                  'browser_close',
                ],
              },
            })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    `yukari: ${API_PATH}/*`,
  )
}
