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
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { planRestart, scheduleRestart } from './host/runtime/lib/restart.js'
import { compare, isVersionText } from './host/runtime/lib/versions.js'
import { mountedComponents } from './host/shared/mounted.js'
import { appError, guardRoute, messageOf, readJsonBody, sendJson } from './host/shared/http.js'
import { busyLabel, runExclusive } from './host/shared/busy.js'
import { resolveDshHome } from './host/shared/home.js'
import { acquireUpdateLock } from './host/runtime/lib/update-guard.js'

const execFileAsync = promisify(execFile)
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = 'yukari-dsh-plugin'
const DEFAULT_REPO = { owner: 'Yukari-Lily', repo: 'Yukari-dsh-plugin', ref: '' }

/** Read-only endpoint prefix the panel calls. */
export const API_PATH = '/yukari/api'

/** Services the main row needs. */
export const inject = ['webServer', 'connection', 'pluginManager']

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

/** 模块会被 HMR 重新执行，进程标识必须挂在进程级对象上；execve 后才会重新生成。 */
const BOOT_KEY = Symbol.for('yukari-dsh-plugin.boot-id')
const BOOT_ID = (globalThis[BOOT_KEY] ??= randomUUID())


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
  // 完整 SHA 只固定本次安装；更新检查仍跟踪默认分支，否则迁移后再也找不到新版。
  return { owner: match[1], repo: match[2], ref: /^[0-9a-f]{40}$/iu.test(ref) ? '' : ref }
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
    installedSha: installed,
    available: (newerVersion || newerCommit) && !(pendingRestart && latestCommit === installed),
    pendingRestart,
    updatable: install.kind !== 'unknown',
    source: install.kind === 'profile' ? install.spec : `${install.repo.owner}/${install.repo.repo}`,
    checkedAt: new Date().toISOString(),
  }
}

/** 固定完整 commit，官方更新器才能精确恢复旧版。 */
function pinnedSpec(repo, commit) {
  if (!/^[0-9a-f]{40}$/u.test(String(commit ?? ''))) throw new Error('没有取得目标 commit，无法通过插件管理器更新')
  return `github:${repo.owner}/${repo.repo}#${commit}`
}

/** 官方管理器会用返回值报告失败，不一定抛异常。 */
function managerFailed(result) {
  return result?.application === 'failed' || result?.application === 'cancelled'
}

/** 同时保留目标失败原因和旧版恢复结果，避免只报一句更新失败。 */
function managerError(result, restore) {
  const diagnostic = result?.error?.diagnostic ?? result?.error?.code ?? `插件管理器在 ${result?.stage ?? 'install'} 阶段失败`
  let suffix = ''
  if (restore !== undefined) {
    suffix = managerFailed(restore)
      ? '；旧版恢复失败'
      : restore.application === 'restart-required' ? '；旧版已安装，重启后恢复' : '；已恢复旧版'
  }
  return new Error(`${diagnostic}${suffix}`)
}

/** 直接抛异常和返回失败值都必须进入旧版恢复路径。 */
async function managerSettled(operation) {
  try {
    return await operation()
  } catch (error) {
    return { application: 'failed', stage: 'install', error: { diagnostic: messageOf(error) } }
  }
}

/** 把官方结果压缩成路由需要的版本与应用状态。 */
function managerApplied(result, fallbackVersion) {
  if (managerFailed(result)) throw managerError(result)
  return {
    updated: result.changed !== false,
    installed: result.version ?? fallbackVersion,
    application: result.application,
    restartReason: result.restartReason ?? null,
  }
}

/**
 * 与「插件」页共用同一个管理器。旧安装跟踪分支，移动的分支无法可靠恢复；
 * 首次先迁移成固定 commit，之后由 updateBundle 负责兼容检查、替换和回滚。
 */
export async function updateProfile(ctx, install, before) {
  if (!isVersionText(before.latest)) throw new Error('没有取得目标版本号，无法通过插件管理器更新')
  const targetSpec = pinnedSpec(install.repo, before.latestSha)
  const manager = ctx.pluginManager
  const bundles = await manager.listBundles()
  const current = bundles.find((item) => item.name === PACKAGE_NAME)
  if (current === undefined) throw new Error('插件管理器找不到当前安装，请在「插件」页重新安装')

  // 官方管理器的 updateBundle 要求目标版本严格大于已装版本（semver.gt），版本号回退——比如把历史
  // 重写、版本重新编号——会被它直接拒绝。更新只认 commit，所以这种情况走「按固定 commit 移除再装」。
  const newerVersion = compare(before.latest, before.installed ?? before.current ?? '0.0.0') > 0
  if (current.update === 'git' && newerVersion) {
    const outcome = await manager.updateBundle(PACKAGE_NAME, before.latest, { spec: targetSpec })
    if (managerFailed(outcome.result)) throw managerError(outcome.result, outcome.restore)
    return managerApplied(outcome.result, before.latest)
  }

  // 固定 commit 会丢掉原分支名；非默认分支不能静默改成跟踪 HEAD。
  if (install.repo.ref !== '') throw new Error('非默认分支请在「插件」页重新安装目标 commit，避免更新时切换分支')

  // 没有 HMR 时官方管理器会覆盖安装并报告 restart-required；
  // expected 同时校验实际落地的包和版本，不能只凭锁文件判断成功。
  if (ctx.get('hmr') === undefined) {
    const result = await managerSettled(() => manager.installBundle(targetSpec, {
      enabled: current.enabled !== false,
      expected: { name: PACKAGE_NAME, version: before.latest },
    }))
    return managerApplied(result, before.latest)
  }

  // 卸载之前先确认当前副本可恢复，不能等失败时才发现旧 commit 未知。
  const previous = pinnedSpec(install.repo, before.installedSha)
  const removal = await manager.removeBundle(PACKAGE_NAME)
  if (managerFailed(removal)) throw managerError(removal)
  const enabled = current.enabled !== false
  const result = await managerSettled(() => manager.installBundle(targetSpec, {
    enabled,
    expected: { name: PACKAGE_NAME, version: before.latest },
  }))
  if (managerFailed(result)) {
    if (result.stage === 'enable') await managerSettled(() => manager.removeBundle(PACKAGE_NAME))
    // 恢复实际运行过的 commit，不能恢复可能已经移动的旧分支。
    const restore = await managerSettled(() => manager.installBundle(previous, { enabled }))
    throw managerError(result, restore)
  }
  return managerApplied(result, before.latest)
}

/**
 * 安装新版，并报告管理器是否已经将其激活。
 * @param ctx - 带官方管理器和可选 HMR 的插件上下文。
 * @param before - 本次更新前的 {@link checkUpdate} 结果。
 */
async function applyUpdate(ctx, before) {
  const install = locateInstall()
  if (install.kind === 'git') {
    const { stdout } = await execFileAsync('git', ['pull', '--ff-only'], { cwd: install.dir, timeout: 60000 })
    return { updated: true, installed: packageVersion(), application: 'restart-required', restartReason: 'module-comparison', detail: stdout.trim() }
  }
  if (install.kind !== 'profile') throw new Error('找不到安装位置，请在「插件」页重新安装')
  return await updateProfile(ctx, install, before)
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
  let restartQueued = false

  /** Everything except the icon, behind the connection guard and one error boundary. */
  const guarded = guardRoute(ctx, async (req, res) => {
    const url = new URL(String(req.url), 'http://localhost')
    const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')

    if ((action === '' || action === 'overview') && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        overview: {
          version: RUNNING_VERSION,
          pid: process.pid,
          bootId: BOOT_ID,
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
      const body = await readJsonBody(req).catch(() => ({}))
      // The lock is taken before the first await, so two clicks cannot both
      // pass a `if (updating)` check and then interleave their installs.
      const result = await runExclusive('更新插件', async () => {
        // 另一个 Host 进程可能正对着同一个 profile 安装；进程内锁管不到它。
        const release = acquireUpdateLock(resolveDshHome())
        try {
          const before = await checkUpdate()
          if (!before.available) return { ok: true, updated: false, update: before }
          const applied = await applyUpdate(ctx, before)
          const pendingRestart = applied.application === 'restart-required'
          // 文件变化会先重载客户端，所以必须重启时只能由 Host 在响应后安排；
          // 已经热应用的新版不能再重启一次。
          let restarted = false
          if (body.restart === true && pendingRestart) {
            scheduleRestart(planRestart({ mode: 'auto' }), { delayMs: 900, reason: 'yukari plugin update' })
            restarted = true
          }
          return {
            ok: true,
            ...applied,
            restarted,
            update: {
              ...before,
              current: pendingRestart ? before.current : applied.installed,
              installed: applied.installed,
              currentCommit: pendingRestart ? before.currentCommit : before.latestCommit,
              available: false,
              pendingRestart,
            },
          }
        } finally {
          release()
        }
      })
      sendJson(res, 200, result)
      return
    }
    if (action === 'restart' && req.method === 'POST') {
      if (restartQueued) throw appError('重启已经在队列里', 'restart-queued')
      // Restarting mid-install would leave a half-written global prefix.
      const busy = busyLabel()
      if (busy !== null) {
        const error = new Error(`正在${busy}，请等待完成后再试`)
        error.status = 409
        throw error
      }
      const plan = planRestart({ mode: 'auto' })
      const ack = scheduleRestart(plan, { delayMs: 800, reason: 'yukari panel' })
      restartQueued = true
      sendJson(res, 202, { ok: true, ...ack })
      return
    }
    sendJson(res, 404, { ok: false, error: `unknown action "${action}"` })
  })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')

          // The icon is fetched by <img> and has to answer without the guard.
          if (action === 'icon' && req.method === 'GET') {
            const bytes = iconBytes()
            res.statusCode = bytes.length === 0 ? 404 : 200
            res.setHeader('content-type', 'image/png')
            res.setHeader('cache-control', 'public, max-age=86400')
            res.end(bytes)
            return
          }
          return guarded(req, res)
        },
      }),
    `yukari: ${API_PATH}/*`,
  )
}
