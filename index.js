/**
 * Yukari 插件合集 — 主行。
 *
 * 各组件由 `cordis.patch.yml` 里各自独立的行挂载（`yukari-dsh-plugin/<name>`），
 * 在插件管理里可以单独开关。主行只负责面板需要的公共接口：
 *
 * - `GET  /yukari/api/overview`      版本与各组件的启用状态；
 * - `GET  /yukari/api/update`        检查插件是否有新版本；
 * - `POST /yukari/api/update`        有新版本时更新插件；
 * - `POST /yukari/api/restart`       运行时组件关闭时的重启兜底；
 * - `GET  /yukari/api/icon`          面板与侧边栏图标。
 *
 * 主行不再代为挂载子组件：子组件只由自己的行挂载，避免同一路由被注册两次。
 * @module yukari-dsh-plugin
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { planRestart, scheduleRestart } from './host/runtime/lib/restart.js'
import { compare } from './host/runtime/lib/versions.js'
import { mountedComponents } from './host/shared/mounted.js'

const execFileAsync = promisify(execFile)
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = 'yukari-dsh-plugin'
const DEFAULT_REPO = { owner: 'Yukari-Lily', repo: 'Yukari-dsh-plugin', ref: '' }

/** Read-only endpoint prefix the panel calls. */
export const API_PATH = '/yukari/api'

/** Services the main row needs. */
export const inject = ['webServer', 'connection']

/** Version of the code loaded in this process. */
function packageVersion(dir = PLUGIN_DIR) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const RUNNING_VERSION = packageVersion()

/** Serialize one JSON response. */
function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/* ------------------------------------------------------------- install info */

/** Parse a pnpm/npm git spec into GitHub coordinates, or null. */
export function parseRepoSpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') return null
  const hash = text.indexOf('#')
  const ref = hash === -1 ? '' : text.slice(hash + 1).replace(/^semver:.*/, '')
  const body = hash === -1 ? text : text.slice(0, hash)
  const match =
    /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(body) ??
    /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(body)
  if (match === null) return null
  return { owner: match[1], repo: match[2], ref }
}

/** Where this copy came from and how it can be updated. */
function locateInstall() {
  if (existsSync(path.join(PLUGIN_DIR, '.git'))) return { kind: 'git', dir: PLUGIN_DIR, repo: DEFAULT_REPO }
  let real = PLUGIN_DIR
  try {
    real = realpathSync(PLUGIN_DIR)
  } catch {
    real = PLUGIN_DIR
  }
  const parts = real.split(path.sep)
  const index = parts.indexOf('node_modules')
  if (index > 0) {
    const profileDir = parts.slice(0, index).join(path.sep) || path.sep
    try {
      const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
      const spec = manifest.dependencies?.[PACKAGE_NAME]
      if (typeof spec === 'string' && spec !== '') {
        return { kind: 'profile', profileDir, spec, repo: parseRepoSpec(spec) ?? DEFAULT_REPO, real }
      }
    } catch {
      // not a profile directory
    }
  }
  return { kind: 'unknown', repo: DEFAULT_REPO, real }
}

/** Commit of the installed copy: from the lockfile, else from the pnpm store path. */
function installedCommit(install) {
  if (install.kind === 'profile') {
    try {
      const lock = readFileSync(path.join(install.profileDir, 'pnpm-lock.yaml'), 'utf8')
      const pattern = new RegExp(`${install.repo.repo}[^\\n]*?([0-9a-f]{40})`, 'i')
      const found = pattern.exec(lock)
      if (found !== null) return found[1].toLowerCase()
    } catch {
      // no lockfile
    }
  }
  const fromPath = /([0-9a-f]{40})/i.exec(install.real ?? '')
  return fromPath === null ? null : fromPath[1].toLowerCase()
}

/** Commit the running copy was loaded from (never changes until a restart). */
const RUNNING_COMMIT = (() => {
  try {
    return installedCommit(locateInstall())
  } catch {
    return null
  }
})()

/** Fetch one URL with a timeout. */
async function fetchWithTimeout(url, ms, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Newest commit of the tracked branch. */
async function remoteCommit(repo) {
  const ref = repo.ref === '' ? 'HEAD' : repo.ref
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', `https://github.com/${repo.owner}/${repo.repo}.git`, ref], {
      timeout: 15000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const match = /^([0-9a-f]{40})/im.exec(stdout)
    if (match !== null) return match[1].toLowerCase()
  } catch {
    // fall back to the API
  }
  try {
    const response = await fetchWithTimeout(`https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`, 10000, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': PACKAGE_NAME },
    })
    if (response.ok) {
      const body = await response.json()
      if (typeof body?.sha === 'string') return body.sha.toLowerCase()
    }
  } catch {
    // unreachable
  }
  return null
}

/** `version` of package.json at one commit or ref. */
async function remoteVersion(repo, at) {
  const ref = at ?? (repo.ref === '' ? 'HEAD' : repo.ref)
  const urls = [
    `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${ref}/package.json`,
    `https://cdn.jsdelivr.net/gh/${repo.owner}/${repo.repo}@${ref}/package.json`,
  ]
  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, 10000, { headers: { 'user-agent': PACKAGE_NAME } })
      if (!response.ok) continue
      const body = await response.json()
      if (typeof body?.version === 'string') return body.version
    } catch {
      // try the next mirror
    }
  }
  return null
}

/** Compare the running copy with the newest commit of its branch. */
async function checkUpdate() {
  const install = locateInstall()
  const installed = installedCommit(install)
  const latestCommit = await remoteCommit(install.repo)
  const latestVersion = await remoteVersion(install.repo, latestCommit ?? undefined)
  if (latestCommit === null && latestVersion === null) {
    throw new Error('连不上 GitHub，无法检查更新（检查网络或在「代理」里启用节点）')
  }
  const onDisk = packageVersion()
  const newerVersion = latestVersion !== null && compare(latestVersion, onDisk) > 0
  const newerCommit = latestCommit !== null && installed !== null && latestCommit !== installed
  // Installed on disk but not loaded yet: the copy changed since this process started.
  const pendingRestart =
    onDisk !== RUNNING_VERSION || (installed !== null && RUNNING_COMMIT !== null && installed !== RUNNING_COMMIT)
  return {
    current: RUNNING_VERSION,
    installed: onDisk,
    installDir: install.kind === 'profile' ? install.profileDir : PLUGIN_DIR,
    latest: latestVersion ?? RUNNING_VERSION,
    currentCommit: (RUNNING_COMMIT ?? installed)?.slice(0, 7) ?? null,
    latestCommit: latestCommit?.slice(0, 7) ?? null,
    latestSha: latestCommit,
    available: (newerVersion || newerCommit) && !(pendingRestart && latestCommit === installed),
    pendingRestart,
    updatable: install.kind !== 'unknown',
    source: install.kind === 'profile' ? install.spec : `${install.repo.owner}/${install.repo.repo}`,
    checkedAt: new Date().toISOString(),
  }
}

/** Run the package manager the profile uses. */
async function runPnpm(args, cwd) {
  const attempts = [['pnpm', args], ['corepack', ['pnpm', ...args]]]
  let lastError = null
  for (const [command, argv] of attempts) {
    try {
      return await execFileAsync(command, argv, {
        cwd,
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CI: 'true' },
      })
    } catch (error) {
      lastError = error
      if (error?.code !== 'ENOENT') break
    }
  }
  const detail = String(lastError?.stderr || lastError?.stdout || messageOf(lastError)).trim()
  throw new Error(detail.split('\n').slice(-6).join('\n'))
}

/**
 * Pull the newest copy into the profile this process was loaded from, then
 * check the files the next start will load: the lockfile commit and the
 * package.json version next to this module. A run that changed neither is a
 * failure, never a "restart to apply".
 * @param before - the {@link checkUpdate} result the update was started from.
 */
async function applyUpdate(before) {
  const install = locateInstall()
  if (install.kind === 'git') {
    const { stdout } = await execFileAsync('git', ['pull', '--ff-only'], { cwd: install.dir, timeout: 60000 })
    return { updated: true, installed: packageVersion(), detail: stdout.trim() }
  }
  if (install.kind !== 'profile') throw new Error('找不到安装位置，请在「插件」页重新安装')
  const target = before.latestSha
  const landed = () => {
    const commit = installedCommit(install)
    if (target !== null && commit !== null) return commit === target
    // No commit to compare: the version on disk has to reach the published one.
    return compare(packageVersion(), before.latest) >= 0 && packageVersion() !== RUNNING_VERSION
  }
  await runPnpm(['add', install.spec], install.profileDir)
  // `pnpm add` can keep a git dependency at its locked commit; `update` re-resolves it.
  if (!landed()) await runPnpm(['update', PACKAGE_NAME], install.profileDir)
  if (!landed()) {
    throw new Error(`pnpm 在 ${install.profileDir} 里没有装上新版本（磁盘上仍是 v${packageVersion()}），请在「插件」页重新安装`)
  }
  return { updated: true, installed: packageVersion(), detail: `已更新到 v${packageVersion()}，重启后生效` }
}

/* --------------------------------------------------------------------- icon */

let iconCache = null
function iconBytes() {
  if (iconCache === null) {
    try {
      iconCache = readFileSync(path.join(PLUGIN_DIR, 'icon.png'))
    } catch {
      iconCache = Buffer.alloc(0)
    }
  }
  return iconCache
}

/* -------------------------------------------------------------------- apply */

/**
 * Register the main row.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  let updating = false
  let restartQueued = false

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')

          if (action === 'icon' && req.method === 'GET') {
            const bytes = iconBytes()
            res.statusCode = bytes.length === 0 ? 404 : 200
            res.setHeader('content-type', 'image/png')
            res.setHeader('cache-control', 'public, max-age=86400')
            res.end(bytes)
            return
          }

          const rejection = ctx.connection.requestRejection(req)
          if (rejection !== undefined && rejection !== null) {
            res.statusCode = rejection
            res.end()
            return
          }

          try {
            if ((action === '' || action === 'overview') && req.method === 'GET') {
              sendJson(res, 200, {
                ok: true,
                overview: {
                  version: RUNNING_VERSION,
                  pid: process.pid,
                  hostname: hostname(),
                  at: new Date().toISOString(),
                  components: mountedComponents(ctx),
                },
              })
              return
            }
            if (action === 'update' && req.method === 'GET') {
              sendJson(res, 200, { ok: true, update: await checkUpdate() })
              return
            }
            if (action === 'update' && req.method === 'POST') {
              if (updating) throw new Error('更新正在进行中')
              updating = true
              try {
                const before = await checkUpdate()
                if (!before.available) {
                  sendJson(res, 200, { ok: true, updated: false, update: before })
                  return
                }
                const result = await applyUpdate(before)
                sendJson(res, 200, { ok: true, ...result, update: { ...before, available: false, pendingRestart: true } })
              } finally {
                updating = false
              }
              return
            }
            if (action === 'restart' && req.method === 'POST') {
              if (restartQueued) throw new Error('重启已经在队列里')
              const plan = planRestart({ mode: 'auto' })
              const ack = scheduleRestart(plan, { delayMs: 800, reason: 'yukari panel' })
              restartQueued = true
              sendJson(res, 202, { ok: true, ...ack })
              return
            }
            sendJson(res, 404, { ok: false, error: `unknown action "${action}"` })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: messageOf(error) })
          }
        },
      }),
    `yukari: ${API_PATH}/*`,
  )
}
