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
import { createRequire } from 'node:module'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
        return { kind: 'profile', profileDir, spec, repo: parseRepoSpec(spec), real }
      }
    } catch {
      // not a profile directory
    }
  }
  return { kind: 'unknown', real }
}

/**
 * 安装来源的种类。
 *
 * 只有 `github` 的副本能自己去问仓库；npm 包、安装包、本地目录、别家 Git 托管的副本
 * 都只能由人装新版，更新检查不该拿它们去问一个写死的仓库。
 *
 * @param spec - profile 里保存的依赖规格。
 * @returns 来源种类。
 */
export function installSourceKind(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') return 'unknown'
  if (parseRepoSpec(text) !== null) return 'github'
  const tarball = /\.(?:tgz|tar\.gz)(?:#.*)?$/iu.test(text)
  if (/^(?:file|link):/iu.test(text) || path.isAbsolute(text)) return tarball ? 'tarball' : 'path'
  if (tarball) return 'tarball'
  if (/^(?:github|gitlab|bitbucket|gist):|^git(?:\+[a-z]+)?:\/\//iu.test(text) || /^git@[^:]+:/iu.test(text) || /^https?:\/\//iu.test(text)) {
    return 'git'
  }
  return 'registry'
}

/**
 * 这份安装的来源，以及它能否自己更新。
 * @param install - {@link locateInstall} 的结果。
 * @returns 来源种类、能否自动更新、GitHub 坐标（不可自动更新时为 null）与原始规格。
 */
export function installSource(install) {
  const kind = install.kind === 'git' ? 'github' : install.kind === 'profile' ? installSourceKind(install.spec) : 'unknown'
  // 只有本机 checkout 没有规格可读，才用写死的仓库；profile 安装一律以保存的规格为准。
  const repo = install.kind === 'git' ? (install.repo ?? DEFAULT_REPO) : kind === 'github' ? parseRepoSpec(install.spec) : null
  const source = install.kind === 'profile' ? String(install.spec ?? '') : repo === null ? '' : `${repo.owner}/${repo.repo}`
  return { kind, updatable: repo !== null, repo, source }
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

/** Proxy variables a child process may use to reach the network. */
const EGRESS_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']

/** Host names that mean "this machine's own proxy" rather than an operator's proxy. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * The environment a child gets when the update must reach the network on its
 * own: the process environment without any proxy names.
 *
 * @returns a fresh environment object.
 */
export function directChildEnv() {
  const env = { ...process.env }
  for (const name of EGRESS_NAMES) Reflect.deleteProperty(env, name)
  Reflect.deleteProperty(env, 'NODE_USE_ENV_PROXY')
  return env
}

/**
 * Clear the Host's own launch-time proxy policy when it points at this
 * plugin's loopback listener.
 *
 * A restart while the route is enabled bakes `HTTP_PROXY=http://127.0.0.1:<port>`
 * into the Host's launch environment. DSH remembers that as its proxy policy and
 * re-publishes it into every child it spawns — clearing `process.env` alone does
 * not reach those children. Installing a direct policy through the same module
 * instance the Host uses is the only way to release it from inside a plugin.
 *
 * The host package is resolved from the running CLI entry, so this works on any
 * install. 找不到宿主模块时维持旧行为，由直连预检兜底；一旦确认 Host 正使用
 * 本插件的回环路由，释放失败就必须取消更新，不能带着旧策略卸载监听器。
 *
 * @returns whether a direct policy was installed.
 */
export async function releaseHostProxyPolicy() {
  let hostProxy
  try {
    const hostEntry = process.argv[1]
    if (typeof hostEntry !== 'string' || hostEntry === '') return false
    const requireFromHost = createRequire(hostEntry)
    const modulePath = requireFromHost.resolve('@deepseek-ai/dsh-http-proxy')
    hostProxy = await import(pathToFileURL(modulePath).href)
  } catch {
    return false
  }
  if (typeof hostProxy.installProxyFromEnvironment !== 'function' || typeof hostProxy.proxyRouteFor !== 'function') return false
  // Only a policy that routes through this machine's loopback listener is ours
  // to drop; an operator-set proxy must survive.
  const route = hostProxy.proxyRouteFor(new URL('https://github.com/'))
  if (route?.proxied !== true || typeof route.proxy !== 'string') return false
  const host = new URL(route.proxy).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!LOOPBACK_NAMES.has(host)) return false
  // An empty launch environment resolves to the direct policy. The disposer is
  // deliberately dropped: the route must stay direct through the update.
  try {
    await hostProxy.installProxyFromEnvironment({ get: () => undefined }, () => {})
  } catch (error) {
    throw new Error(`无法释放 Host 的本机代理策略，已取消更新：${messageOf(error)}`)
  }
  return true
}

/**
 * Refuse an update whose installer would have no way back to GitHub.
 *
 * The old copy is removed before the new one is installed. When the install
 * cannot reach GitHub directly, that step fails and the network-based rollback
 * fails with it, leaving an empty profile. This check runs while the old copy is
 * still installed, with the proxy names stripped, so it measures exactly the
 * network the installer will have after removal.
 *
 * @param repo - owner and repository of the installed copy.
 * @param run - process runner, replaceable by tests.
 * @throws when direct access fails.
 */
export async function assertDirectGithub(repo, run = execFileAsync) {
  const url = `https://github.com/${repo.owner}/${repo.repo}.git`
  try {
    await run('git', ['ls-remote', '--heads', url], { timeout: 20000, env: directChildEnv() })
  } catch (error) {
    const detail = messageOf(error).split('\n')[0]
    throw new Error(`直连 GitHub 失败，已取消更新以免卸载旧版后装不回来（${detail}）；请检查直连网络后重试`)
  }
}

/**
 * Drop proxy variables that point at this plugin's own loopback listener.
 *
 * The host hands its children the environment it booted with. Once an update
 * removes the proxy component, `git` and `pnpm` behind the installer still dial
 * the now-closed loopback port and the update fails after the old copy is
 * already gone. Clearing these variables first lets the installer go direct.
 * Only loopback values are touched, so an operator-set proxy survives.
 *
 * @returns the names that were cleared.
 */
export function releaseLocalEgress() {
  const cleared = []
  for (const name of EGRESS_NAMES) {
    const value = process.env[name]
    if (typeof value !== 'string' || value.length === 0) continue
    let url
    try {
      url = new URL(value)
    } catch {
      continue
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (!LOOPBACK_NAMES.has(host)) continue
    Reflect.deleteProperty(process.env, name)
    cleared.push(name)
  }
  if (cleared.length === 0) return cleared
  // Node's built-in fetch reads this to decide whether to honour the variables.
  Reflect.deleteProperty(process.env, 'NODE_USE_ENV_PROXY')
  return cleared
}

/**
 * Compare the running copy with the newest commit of its branch.
 *
 * 只有 GitHub 来源的副本才有仓库可比：npm 包、安装包、本地目录的副本没有远端版本可问，
 * 拿写死的仓库去问只会得到一个对方装不回来的新版，所以这些来源直接报告"要人装新版"。
 */
async function checkUpdate() {
  const install = locateInstall()
  const source = installSource(install)
  const onDisk = packageVersion()
  const base = {
    current: RUNNING_VERSION,
    installed: onDisk,
    installDir: install.kind === 'profile' ? install.profileDir : PLUGIN_DIR,
    restartSupported: process.platform !== 'win32',
    sourceKind: source.kind,
    source: source.source,
    checkedAt: new Date().toISOString(),
  }
  if (!source.updatable) {
    return {
      ...base,
      latest: onDisk,
      latestKnown: true,
      currentCommit: null,
      latestCommit: null,
      latestSha: null,
      installedSha: null,
      available: false,
      pendingRestart: onDisk !== RUNNING_VERSION,
      updatable: false,
    }
  }
  const installed = installedCommit(install)
  const latestCommit = await remoteCommit(source.repo)
  const latestVersion = await remoteVersion(source.repo, latestCommit ?? undefined)
  if (latestCommit === null && latestVersion === null) {
    throw new Error('连不上 GitHub，无法检查更新（检查网络或在「代理」里启用节点）')
  }
  // 版本号取不到（例如 Windows 上 raw.githubusercontent.com 的 fetch 失败）时，
  // latest 只是界面兜底，不能当成远端版本：它既不能用来比较新旧，也不能作为
  // 安装目标的 expected.version，否则装上的 0.8.0 会被当成 0.7.8 拒收并回滚。
  const latestKnown = latestVersion !== null
  const newerVersion = latestKnown && compare(latestVersion, onDisk) > 0
  const newerCommit = latestCommit !== null && installed !== null && latestCommit !== installed
  // Installed on disk but not loaded yet: the copy changed since this process started.
  const pendingRestart =
    onDisk !== RUNNING_VERSION || (installed !== null && RUNNING_COMMIT !== null && installed !== RUNNING_COMMIT)
  return {
    ...base,
    latest: latestVersion ?? onDisk,
    latestKnown,
    currentCommit: (RUNNING_COMMIT ?? installed)?.slice(0, 7) ?? null,
    latestCommit: latestCommit?.slice(0, 7) ?? null,
    latestSha: latestCommit,
    installedSha: installed,
    available: (newerVersion || newerCommit) && !(pendingRestart && latestCommit === installed),
    pendingRestart,
    updatable: true,
  }
}

/**
 * 交给官方管理器的 `expected`。
 *
 * 管理器要求 `{ name, version }` 成对出现，版本未知时传一半会被判成
 * `unexpected-package`。这时宁可不传：安装结果仍由 commit 与插件列表校验。
 */
function expectedTarget(knownVersion, version) {
  return knownVersion ? { expected: { name: PACKAGE_NAME, version } } : {}
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
function managerError(result, restore, note = '') {
  const diagnostic = result?.error?.diagnostic ?? result?.error?.code ?? `插件管理器在 ${result?.stage ?? 'install'} 阶段失败`
  let suffix = ''
  if (restore !== undefined) {
    suffix = managerFailed(restore)
      ? '；旧版恢复失败'
      : restore.application === 'restart-required' ? '；旧版已安装，重启后恢复' : '；已恢复旧版'
  }
  return new Error(`${diagnostic}${note === '' ? suffix : note}`)
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
export async function updateProfile(ctx, install, before, options = {}) {
  // 版本号只是界面信息；安装认的是 commit。拿不到远端版本号时照常按 commit 安装，
  // 但不能再把它当成目标包的版本参与校验。
  const knownVersion = before.latestKnown !== false && isVersionText(before.latest)
  const targetSpec = pinnedSpec(install.repo, before.latestSha)
  const manager = ctx.pluginManager
  const bundles = await manager.listBundles()
  const current = bundles.find((item) => item.name === PACKAGE_NAME)
  if (current === undefined) throw new Error('插件管理器找不到当前安装，请在「插件」页重新安装')

  // 官方管理器的 updateBundle 要求目标版本严格大于已装版本（semver.gt），版本号回退——比如把历史
  // 重写、版本重新编号——会被它直接拒绝。更新只认 commit，所以这种情况走「按固定 commit 移除再装」。
  const newerVersion = knownVersion && compare(before.latest, before.installed ?? before.current ?? '0.0.0') > 0
  if (current.update === 'git' && newerVersion) {
    // HMR 的 updateBundle 会先卸载旧 bundle，本机代理监听器也随之消失；这和下面
    // 手动移除再安装走的是同一条危险路径。没有 HMR 时才是覆盖安装，旧路由保持可用。
    if (ctx.get('hmr') !== undefined) await prepareRemoval(ctx, install, options)
    const outcome = await manager.updateBundle(PACKAGE_NAME, before.latest, { spec: targetSpec })
    if (managerFailed(outcome.result)) throw managerError(outcome.result, outcome.restore)
    await verifyInstalled(manager, outcome.result)
    return managerApplied(outcome.result, before.latest)
  }

  // 从这里开始旧版会被移出 profile，代理监听器也随之消失：先释放本机回环路由，
  // 再证明直连可用，否则卸载之后既装不回新版，也回滚不了旧版。
  await prepareRemoval(ctx, install, options)

  // 固定 commit 会丢掉原分支名；非默认分支不能静默改成跟踪 HEAD。
  if (install.repo.ref !== '') throw new Error('非默认分支请在「插件」页重新安装目标 commit，避免更新时切换分支')

  // 没有 HMR 时官方管理器会覆盖安装并报告 restart-required；
  // expected 同时校验实际落地的包和版本，不能只凭锁文件判断成功。
  if (ctx.get('hmr') === undefined) {
    const result = await managerSettled(() => manager.installBundle(targetSpec, {
      enabled: current.enabled !== false,
      ...(expectedTarget(knownVersion, before.latest)),
    }))
    const applied = managerApplied(result, knownVersion ? before.latest : packageVersion())
    await verifyInstalled(manager, result)
    return applied
  }

  // 卸载之前先确认旧 commit 可恢复，不能等失败时才发现它未知。
  const previous = pinnedSpec(install.repo, before.installedSha)
  const removal = await manager.removeBundle(PACKAGE_NAME)
  if (managerFailed(removal)) throw managerError(removal)
  const enabled = current.enabled !== false
  const result = await managerSettled(() => manager.installBundle(targetSpec, {
    enabled,
    ...(expectedTarget(knownVersion, before.latest)),
  }))
  if (managerFailed(result)) {
    if (result.stage === 'enable') await managerSettled(() => manager.removeBundle(PACKAGE_NAME))
    // 恢复实际运行过的 commit，不能恢复可能已经移动的旧分支。
    const restore = await managerSettled(() => manager.installBundle(previous, { enabled }))
    throw managerError(result, restore)
  }
  await verifyInstalled(manager, result)
  return managerApplied(result, knownVersion ? before.latest : packageVersion())
}

/**
 * 把旧版移出 profile 之前，先把安装要走的路变成「不依赖本插件」。
 *
 * 卸载会把本机代理一起带走，宿主又把子进程的代理变量钉在启动时的值上：不先释放，
 * pnpm 与 git 会一直拨那个已经关掉的回环端口。释放之后必须确认直连能用，否则
 * 卸载之后既装不回新版，也回滚不了旧版。
 *
 * @param ctx - plugin context, for the log.
 * @param install - {@link locateInstall} 的结果。
 * @param options.preflight - 测试用的预检替身；只放在参数上，不读 Cordis 上下文。
 */
async function prepareRemoval(ctx, install, options) {
  const policyReleased = await releaseHostProxyPolicy()
  const clearedEgress = releaseLocalEgress()
  if (clearedEgress.length > 0 || policyReleased) {
    try {
      ctx.logger?.('yukari-update')?.warn?.(`released the local proxy route before updating (env: ${clearedEgress.join(', ') || 'none'}, host policy: ${policyReleased ? 'released' : 'unchanged'})`)
    } catch {
      // A missing logger must not stop the update.
    }
  }
  const preflight = typeof options.preflight === 'function' ? options.preflight : () => assertDirectGithub(install.repo)
  await preflight()
}

/**
 * Check that the installed copy is actually registered and enabled.
 *
 * 校验失败只报告真实状态，不在目标包仍占用依赖时再装一份旧包；后者会被
 * 官方管理器以 already-installed 拒绝，还会掩盖最初的注册问题。
 *
 * `installed` 只表示 profile 声明了依赖，`enabled` 只表示保存过的选择：层被跳过时
 * 两项仍为真，只在 `error` 与 `rows[].entryId` 上体现，所以两者都要看。
 *
 * @param manager - the plugin manager.
 * @param result - the install result that claimed success.
 * @throws when the bundle is missing, unreadable, not loaded, or disabled.
 */
async function verifyInstalled(manager, result) {
  let listed
  try {
    listed = await manager.listBundles()
  } catch (error) {
    throw managerError(result, undefined, `；安装后无法读取插件列表，未能确认是否生效（${messageOf(error)}）`)
  }
  const after = listed?.find?.((item) => item.name === PACKAGE_NAME)
  if (after === undefined || after.installed === false) {
    throw managerError(result, undefined, '；新版本没有注册为已启用的插件，请检查「插件」页')
  }
  if (after.availability === 'missing') throw managerError(result, undefined, '；新版本的文件不可读，请检查「插件」页')
  if (after.error !== undefined && after.error !== null) {
    const reason = after.error.code ?? after.error.diagnostic ?? '未知原因'
    throw managerError(result, undefined, `；新版本没有被加载（${reason}），请检查「插件」页`)
  }
  if (after.enabled === false) throw managerError(result, undefined, '；新版本没有启用，请检查「插件」页')
  const rows = Array.isArray(after.rows) ? after.rows : []
  if (rows.length > 0 && rows.every((row) => row.entryId === undefined)) {
    throw managerError(result, undefined, '；新版本的插件行没有生效，请检查「插件」页')
  }
}

/**
 * 安装新版，并报告管理器是否已经将其激活。
 * @param ctx - 带官方管理器和可选 HMR 的插件上下文。
 * @param before - 本次更新前的 {@link checkUpdate} 结果。
 */
async function applyUpdate(ctx, before) {
  const install = locateInstall()
  if (install.kind === 'git') {
    await releaseHostProxyPolicy()
    releaseLocalEgress()
    const { stdout } = await execFileAsync('git', ['pull', '--ff-only'], { cwd: install.dir, timeout: 60000, env: directChildEnv() })
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
          if (body.restart === true && pendingRestart && process.platform !== 'win32') {
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
              restartSupported: process.platform !== 'win32',
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
      if (process.platform === 'win32') throw appError('Windows 客户端不支持从面板重启 dsh', 'runtime-restart-unsupported')
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
