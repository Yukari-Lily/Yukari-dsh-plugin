/**
 * One lazily started Chromium instance shared by every browser tool.
 *
 * The manager owns the process, the DevTools connection, the active page
 * session, and a serial queue so overlapping tool calls cannot interleave
 * half-finished interactions.
 * @module @local/browser-control/browser
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpClient, CdpError, launchChromium, sleep } from './cdp.js'
import { blockedNavigationReason } from './url-guard.js'
import {
  focusExpression,
  resolveExpression,
  scrollExpression,
  snapshotExpression,
  valueExpression,
} from './page-scripts.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')
const RUNTIME_DIR = path.join(PACKAGE_DIR, 'runtime')

/** Budget for reconnecting to a browser that is already running. */
const ADOPT_TIMEOUT_MS = 5000

/**
 * Read the DevTools endpoint Chrome published inside a profile.
 * @param userDataDir - profile directory.
 * @returns `{ endpoint }` or null when nothing usable is there.
 */
function readActivePort(userDataDir) {
  try {
    const [port, pathname] = readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')
    const number = Number(port)
    const wsPath = String(pathname ?? '').trim()
    if (!Number.isInteger(number) || number <= 0) return null
    if (!wsPath.startsWith('/devtools/browser/')) return null
    return { endpoint: `ws://127.0.0.1:${number}${wsPath}` }
  } catch {
    return null
  }
}

/**
 * PID encoded in Chrome's profile lock (`<host>-<pid>`), or null.
 * @param userDataDir - profile directory.
 */
function singletonPid(userDataDir) {
  for (const name of ['SingletonLock', 'SingletonSocket']) {
    try {
      const target = readlinkSync(path.join(userDataDir, name))
      const pid = Number(target.slice(target.lastIndexOf('-') + 1))
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch { /* try the next one */ }
  }
  return null
}

/** Whether a pid is still alive. */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Virtual key codes for the special keys a tool may press. */
const KEYS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
}

/** Turn a requested key name into a dispatchable key description. */
function keySpec(name) {
  const lowered = String(name ?? '').trim().toLowerCase()
  if (KEYS[lowered]) return KEYS[lowered]
  if (lowered.length === 1) {
    const upper = lowered.toUpperCase()
    return { key: lowered, code: `Key${upper}`, vk: upper.charCodeAt(0), text: lowered }
  }
  return { key: String(name), code: String(name), vk: 0 }
}

/** Resolve the browser executable and the environment it needs. */
export function resolveRuntime(config) {
  const libraryPaths = []
  const env = {}
  const runtimeLibs = [
    path.join(RUNTIME_DIR, 'sysroot/usr/lib/aarch64-linux-gnu'),
    path.join(RUNTIME_DIR, 'sysroot/lib/aarch64-linux-gnu'),
  ].filter((dir) => existsSync(dir))
  libraryPaths.push(...runtimeLibs)
  const fontconfig = path.join(RUNTIME_DIR, 'sysroot/etc/fonts')
  if (existsSync(path.join(fontconfig, 'fonts.conf'))) {
    env.FONTCONFIG_PATH = fontconfig
    env.FONTCONFIG_FILE = path.join(fontconfig, 'fonts.conf')
  }
  const configuredLibs = config.libraryPath
  if (typeof configuredLibs === 'string' && configuredLibs.length > 0) {
    libraryPaths.push(...configuredLibs.split(':').filter(Boolean))
  } else if (Array.isArray(configuredLibs)) {
    libraryPaths.push(...configuredLibs.filter((entry) => typeof entry === 'string' && entry.length > 0))
  }
  if (libraryPaths.length > 0) {
    const previous = process.env.LD_LIBRARY_PATH
    env.LD_LIBRARY_PATH = [...libraryPaths, ...(previous ? [previous] : [])].join(':')
  }

  const candidates = []
  if (config.runtimeReady === true && typeof config.executablePath === 'string' && config.executablePath.length > 0) {
    return { executablePath: config.executablePath, env }
  }
  // 显式配置的路径不存在时直接报错：悄悄换成 PATH 里的另一个 Chrome 会把
  // "我指定的浏览器没装"伪装成"一切正常"，排查时完全看不出来。
  const configured = typeof config.executablePath === 'string' ? config.executablePath.trim() : ''
  if (configured !== '' && !existsSync(configured)) {
    throw new CdpError(`配置的浏览器路径不存在：${configured}`)
  }
  if (typeof config.executablePath === 'string' && config.executablePath.length > 0) candidates.push(config.executablePath)
  for (const name of ['DSH_BROWSER_EXECUTABLE', 'CHROME_PATH', 'CHROMIUM_PATH']) {
    const value = process.env[name]
    if (value) candidates.push(value)
  }
  const bundled = [
    path.join(RUNTIME_DIR, 'chrome-headless-shell/chrome-headless-shell'),
    path.join(RUNTIME_DIR, 'chrome-linux/chrome'),
    path.join(RUNTIME_DIR, 'chrome-headless-shell-linux64/chrome-headless-shell'),
  ]
  candidates.push(...bundled)
  candidates.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  )
  const executablePath = candidates.find((candidate) => candidate && existsSync(candidate))
  if (!executablePath) {
    throw new CdpError(
      'no Chromium executable found. Set the plugin config `executablePath`, export DSH_BROWSER_EXECUTABLE, or install Chrome/Chromium at a standard path; the package ships no browser runtime of its own',
    )
  }
  return { executablePath, env }
}

/**
 * Decide whether the Chromium sandbox can stay on.
 *
 * `sandbox: true` always keeps it on, `false` always passes `--no-sandbox`.
 * The default (`auto`) keeps the sandbox except where Chromium provably cannot
 * use it — running as root or inside a container without user namespaces — so
 * the browser works out of the box without silently weakening a normal host.
 * @param config - normalized plugin config.
 * @param detection - environment seams, for tests.
 * @returns `{ enabled, reason, flag }`.
 */
export function sandboxDecision(config = {}, detection = {}) {
  const uid = detection.uid ?? process.getuid?.()
  const container = detection.container ?? existsSync('/.dockerenv')
  if (config.sandbox === true) return { enabled: true, reason: 'configured', flag: '' }
  if (config.sandbox === false) return { enabled: false, reason: 'configured', flag: '--no-sandbox' }
  if (uid === 0) return { enabled: false, reason: 'root', flag: '--no-sandbox' }
  if (container) return { enabled: false, reason: 'container', flag: '--no-sandbox' }
  return { enabled: true, reason: 'auto', flag: '' }
}

/** Timestamped screenshot filename. */
function screenshotName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `browser-${stamp}-${Math.random().toString(36).slice(2, 7)}.png`
}

/** Read the PNG header so a screenshot reports its real dimensions. */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** Human-readable target description for diagnostics. */
function describeTarget(target) {
  if (!target) return 'no target'
  if (target.ref) return `ref ${target.ref}`
  if (target.selector) return `selector ${target.selector}`
  if (target.text) return `text "${target.text}"`
  return 'no target'
}

export class BrowserManager {
  #config
  #client
  #process
  #pages = new Map()
  #active
  #queue = Promise.resolve()
  #starting
  #runtime
  #launchBrowser
  #connectClient
  #profileDir
  #ownsProfile = false
  #screenshotDir
  #ownsScreenshotDir = false
  #exitCleanup
  #closed = false
  #disposing

  /**
   * @param config - the plugin row config, already normalized by the caller.
   * @param runtime - shared automatic Chromium installer.
   * @param dependencies - launch/connect seams, used by the tests.
   */
  constructor(config, runtime, dependencies = {}) {
    this.#config = config
    this.#runtime = runtime
    this.#launchBrowser = dependencies.launch ?? launchChromium
    this.#connectClient = dependencies.connect ?? CdpClient.connect
  }

  /**
   * Run an operation exclusively, so two tool calls never interleave.
   *
   * A supplied signal cancels the call: the plugin closes the DevTools socket,
   * every pending protocol command rejects at once, and the queue moves on. The
   * browser process keeps its profile, so the next call reconnects to it.
   * @param operation - the work to run.
   * @param signal - optional cancellation from the tool executor.
   * @returns the operation's result.
   */
  run(operation, signal) {
    if (this.#closed) return Promise.reject(new CdpError('浏览器组件已关闭'))
    const guarded = async () => {
      if (signal?.aborted === true) throw new CdpError('操作已取消')
      return operation()
    }
    const result = this.#queue.then(guarded, guarded)
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    if (typeof signal?.addEventListener !== 'function') return result
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        try {
          this.#client?.close()
        } catch {
          /* the socket is already gone */
        }
        reject(new CdpError('操作已取消'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      result.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  /** Whether a browser process is currently running. */
  get running() {
    return this.#process !== undefined && this.#client?.open === true
  }

  /**
   * Profile directory for this manager.
   *
   * Without a configured path the directory is created by `mkdtemp`: the name
   * is unpredictable and the mode is 0700, so cookies and login state are not
   * world-readable, and dispose can delete exactly what it created.
   * @returns the absolute profile path.
   */
  #profile() {
    if (this.#profileDir !== undefined) return this.#profileDir
    const configured = this.#config.userDataDir
    if (typeof configured === 'string' && configured.length > 0) {
      this.#profileDir = configured
      return configured
    }
    const directory = mkdtempSync(path.join(tmpdir(), 'dsh-browser-profile-'))
    chmodSync(directory, 0o700)
    this.#profileDir = directory
    this.#ownsProfile = true
    this.#registerExitCleanup()
    return directory
  }

  /** Directory for screenshots, created private when the config names none. */
  #screenshots() {
    if (this.#screenshotDir !== undefined) return this.#screenshotDir
    const configured = this.#config.screenshotDir
    if (typeof configured === 'string' && configured.length > 0) {
      this.#screenshotDir = configured
      return configured
    }
    const directory = mkdtempSync(path.join(tmpdir(), 'dsh-browser-shots-'))
    chmodSync(directory, 0o700)
    this.#screenshotDir = directory
    this.#ownsScreenshotDir = true
    this.#registerExitCleanup()
    return directory
  }

  /** Remove the directories at process exit even if the host never disposes. */
  #registerExitCleanup() {
    if (this.#exitCleanup !== undefined) return
    const cleanup = () => this.#removeTemporaryDirectories()
    process.once('exit', cleanup)
    this.#exitCleanup = () => process.off('exit', cleanup)
  }

  #removeTemporaryDirectories() {
    if (this.#ownsProfile && this.#profileDir !== undefined) rmSync(this.#profileDir, { recursive: true, force: true })
    if (this.#ownsScreenshotDir && this.#screenshotDir !== undefined) rmSync(this.#screenshotDir, { recursive: true, force: true })
  }

  /** Forget the temporary profile so a failed launch leaves nothing behind. */
  #discardProfile() {
    if (!this.#ownsProfile) return
    if (this.#profileDir !== undefined) rmSync(this.#profileDir, { recursive: true, force: true })
    this.#profileDir = undefined
    this.#ownsProfile = false
  }

  #clearTemporaryDirectories() {
    this.#removeTemporaryDirectories()
    this.#profileDir = undefined
    this.#ownsProfile = false
    this.#screenshotDir = undefined
    this.#ownsScreenshotDir = false
    this.#exitCleanup?.()
    this.#exitCleanup = undefined
  }

  /** Start the browser on first use and return the shared connection. */
  async #connect() {
    if (this.#closed) throw new CdpError('浏览器组件已关闭')
    if (this.running) return this.#client
    if (this.#starting) return this.#starting
    this.#starting = this.#launch()
    try {
      return await this.#starting
    } finally {
      this.#starting = undefined
    }
  }

  /** Launch once, discarding a temporary profile when anything fails. */
  async #launch() {
    try {
      return await this.#start()
    } catch (error) {
      this.#discardProfile()
      throw error
    }
  }

  async #start() {
    const config = this.#config
    const userDataDir = this.#profile()
    // Page sessions belong to the socket that created them; a relaunch must
    // never hand an old sessionId to the new connection.
    this.#pages.clear()
    this.#active = undefined
    // A browser started earlier can outlive its DevTools socket. Reconnecting to
    // it keeps the profile and its tabs; spawning a second one on the same
    // profile would abort on Chrome's ProcessSingleton lock instead.
    const adopted = await this.#adopt(userDataDir)
    if (adopted !== null) {
      this.#process = adopted.process
      this.#client = adopted.client
      this.#track(adopted.client)
      return adopted.client
    }
    await this.#reapStale(userDataDir)
    let runtime
    try {
      runtime = resolveRuntime(config)
    } catch (error) {
      if (!this.#runtime) throw error
      const executablePath = await this.#runtime.ensureReady()
      runtime = resolveRuntime({ ...config, executablePath, runtimeReady: true })
    }
    const { executablePath, env } = runtime
    // Libraries and fonts unpacked into DSH_HOME take precedence over the
    // bundled sysroot, and never replace a value the host already set.
    let runtimeEnv = {}
    try {
      runtimeEnv = (await this.#runtime?.environment?.()) ?? {}
    } catch { /* fall back to the host's own libraries */ }
    if (typeof runtimeEnv.LD_LIBRARY_PATH === 'string') {
      env.LD_LIBRARY_PATH = [runtimeEnv.LD_LIBRARY_PATH, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
    }
    if (typeof runtimeEnv.FONTCONFIG_FILE === 'string' && env.FONTCONFIG_FILE === undefined) {
      env.FONTCONFIG_FILE = runtimeEnv.FONTCONFIG_FILE
    }
    if (config.env && typeof config.env === 'object') {
      for (const [key, value] of Object.entries(config.env)) {
        if (typeof value === 'string') env[key] = value
      }
    }
    try { mkdirSync(userDataDir, { recursive: true }) } catch { /* the browser reports a real failure */ }
    // Chrome's crash handler needs a writable HOME of its own; inheriting the
    // operator's home is both fragile and unnecessary.
    if (typeof config.homeDir === 'string' && config.homeDir.length > 0) {
      try {
        mkdirSync(config.homeDir, { recursive: true })
        env.HOME = config.homeDir
        env.XDG_CONFIG_HOME = path.join(config.homeDir, '.config')
        env.XDG_CACHE_HOME = path.join(config.homeDir, '.cache')
      } catch { /* keep the inherited HOME */ }
    }
    if (process.getuid?.() === 0 && config.sandbox === true) {
      throw new CdpError('Chromium sandbox cannot start as root; run as an unprivileged user or set browser sandbox false to accept the risk')
    }
    const sandbox = sandboxDecision(config)
    const args = [
      // Chrome for Testing is a full browser: without a display server it has
      // to be told to run headless before it reaches the crash reporter.
      '--headless=new',
      sandbox.flag,
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--remote-debugging-port=0',
      `--window-size=${config.viewportWidth},${config.viewportHeight}`,
      `--user-data-dir=${userDataDir}`,
      ...(Array.isArray(config.arguments) ? config.arguments.filter((arg) => typeof arg === 'string') : []),
      'about:blank',
    ].filter(Boolean)
    const launched = await this.#launchBrowser({ executablePath, args, env, timeoutMs: config.startTimeoutMs })
    let client
    try {
      client = await this.#connectClient(launched.endpoint, config.startTimeoutMs)
    } catch (error) {
      // The process started but no usable connection exists: stop it now,
      // otherwise the orphan keeps holding the profile and its memory.
      await launched.stop().catch(() => undefined)
      throw error
    }
    this.#process = launched
    this.#client = client
    this.#track(client)
    return client
  }

  /** Follow the target bookkeeping events of one connection. */
  #track(client) {
    client.onEvent((method, params, sessionId) => {
      if (method === 'Target.detachedFromTarget' && params.targetId) this.#pages.delete(params.targetId)
      if (method === 'Target.targetDestroyed' && params.targetId) {
        this.#pages.delete(params.targetId)
        if (this.#active === params.targetId) this.#active = undefined
      }
      if (sessionId !== undefined && this.#active !== undefined && method === 'Page.frameNavigated') {
        // Keeps the active page association alive across navigations.
        void params
      }
    })
    // 连接断开后 manager 必须忘掉旧 client、进程和 page session，否则下一次
    // 调用会把失效的 sessionId 交给一个已经关闭的 socket，工具永久失败。
    client.onClose(() => this.#drop(client))
  }

  /** Forget one dead connection, but only if it is still the current one. */
  #drop(client) {
    if (this.#client !== client) return
    this.#client = undefined
    this.#process = undefined
    this.#pages.clear()
    this.#active = undefined
  }

  /**
   * Reconnect to the browser that still owns this profile.
   * @param userDataDir - profile directory of this manager.
   * @returns the adopted handle and connection, or null when nothing answers.
   */
  async #adopt(userDataDir) {
    const published = readActivePort(userDataDir)
    if (published === null) return null
    let client
    try {
      client = await CdpClient.connect(published.endpoint, ADOPT_TIMEOUT_MS)
    } catch {
      return null
    }
    const pid = singletonPid(userDataDir)
    return {
      client,
      process: {
        endpoint: published.endpoint,
        adopted: true,
        stop: () => this.#killOwned(pid, userDataDir),
      },
    }
  }

  /**
   * Clear a browser that still holds the profile but no longer answers.
   * @param userDataDir - profile directory about to be reused.
   */
  async #reapStale(userDataDir) {
    await this.#killOwned(singletonPid(userDataDir), userDataDir)
  }

  /**
   * Stop the process recorded for this profile, and only if the profile flag
   * proves it is ours: a recycled pid must never be killed by mistake.
   * @param pid - candidate process.
   * @param userDataDir - profile directory it has to be running with.
   * @returns whether a process was stopped.
   */
  async #killOwned(pid, userDataDir) {
    if (pid === null || pid === process.pid) return false
    let cmdline = ''
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    } catch {
      return false
    }
    if (!cmdline.split('\0').includes(`--user-data-dir=${userDataDir}`)) return false
    try { process.kill(pid, 'SIGTERM') } catch { return false }
    for (let i = 0; i < 30 && isAlive(pid); i++) await sleep(100)
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* it exited on its own */ }
    }
    return true
  }

  /** Attach to a page target and configure its viewport. */
  async #attach(targetId) {
    const client = await this.#connect()
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    const page = {
      targetId,
      sessionId,
      send: (method, params = {}) => client.send(method, params, sessionId),
    }
    this.#pages.set(targetId, page)
    await page.send('Page.enable').catch(() => undefined)
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: this.#config.viewportWidth,
      height: this.#config.viewportHeight,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch(() => undefined)
    return page
  }

  /** The page tool calls act on, created on demand. */
  async #currentPage() {
    // Reconnect first: an active page left over from a dead socket must not be
    // returned before the manager notices that the connection is gone.
    await this.#connect()
    if (this.#active !== undefined && this.#pages.has(this.#active)) return this.#pages.get(this.#active)
    const client = await this.#connect()
    const { targetInfos } = await client.send('Target.getTargets')
    for (const info of targetInfos) {
      if (this.#pages.has(info.targetId)) {
        this.#active = info.targetId
        return this.#pages.get(info.targetId)
      }
    }
    const blank = targetInfos.find((info) => info.type === 'page' && info.url === 'about:blank')
    const targetId = blank
      ? blank.targetId
      : (await client.send('Target.createTarget', { url: 'about:blank' })).targetId
    const page = await this.#attach(targetId)
    this.#active = targetId
    return page
  }

  /** Navigate the active page (or a new tab) and wait for the load to settle. */
  async open(url, options = {}) {
    const value = String(url ?? '').trim()
    if (value.length === 0) throw new CdpError('url is required')
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      parsed = new URL(value.includes('://') ? value : `https://${value}`)
    }
    const refused = blockedNavigationReason(parsed, { allowLocalUrls: this.#config.allowLocalUrls === true })
    if (refused !== null) throw new CdpError(refused)
    const page = options.newTab === true ? await this.#newTab() : await this.#currentPage()
    return this.#navigate(page, parsed.href)
  }

  async #newTab() {
    const client = await this.#connect()
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const page = await this.#attach(targetId)
    this.#active = targetId
    return page
  }

  async #navigate(page, url) {
    const navigation = page.send('Page.navigate', { url })
    const loaded = (await this.#connect()).once(
      'Page.loadEventFired',
      (_params, sessionId) => sessionId === page.sessionId,
      this.#config.navigationTimeoutMs,
    ).catch(() => undefined)
    const result = await navigation
    if (result.errorText) throw new CdpError(`navigation failed: ${result.errorText}`)
    await loaded
    await this.#settle(page)
    // A redirect can land on loopback or a private address that the requested
    // URL never showed; the landing address needs the same policy check.
    const landed = await this.evaluateIn(page, 'location.href')
    if (typeof landed !== 'string') throw new CdpError('无法确认导航后的地址')
    const refused = blockedNavigationReason(landed, { allowLocalUrls: this.#config.allowLocalUrls === true })
    if (refused !== null) {
      await page.send('Page.navigate', { url: 'about:blank' }).catch(() => undefined)
      throw new CdpError(`重定向后的地址被拒绝：${refused}`)
    }
    return this.summary(page, 600)
  }

  /** Wait until the document is complete and a short settle window passed. */
  async #settle(page) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const state = await page.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }).then((value) => value.result?.value).catch(() => 'complete')
      if (state === 'complete') break
      await sleep(100)
    }
    if (this.#config.settleMs > 0) await sleep(this.#config.settleMs)
  }

  /** Compact page identity plus a text excerpt. */
  async summary(page, maxText = 800) {
    const value = await this.evaluateIn(page, snapshotExpression({ maxText, maxElements: 0 }))
    return {
      url: value.url,
      title: value.title,
      text: value.text,
      scroll: value.scroll,
      elements: value.elementCount,
    }
  }

  /** Evaluate an expression string in a page session. */
  async evaluateIn(page, expression) {
    const result = await page.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new CdpError(`page script failed: ${String(detail).split('\n')[0]}`)
    }
    return result.result?.value
  }

  /** Evaluate an arbitrary expression in the active page. */
  async evaluate(expression) {
    const page = await this.#currentPage()
    return this.evaluateIn(page, String(expression ?? ''))
  }

  /** Report the page as address, readable text, and interactive elements. */
  async snapshot(options = {}) {
    const page = await this.#currentPage()
    return this.evaluateIn(page, snapshotExpression(options))
  }

  /** Click an element by ref, CSS selector, or visible text. */
  async click(target, options = {}) {
    const page = await this.#currentPage()
    const resolved = await this.evaluateIn(page, resolveExpression(target))
    if (!resolved.found) throw new CdpError(`no element matched ${describeTarget(target)}`)
    const button = options.button === 'right' ? 'right' : 'left'
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: resolved.x, y: resolved.y })
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: resolved.x,
      y: resolved.y,
      button,
      buttons: button === 'left' ? 1 : 2,
      clickCount: 1,
    })
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: resolved.x,
      y: resolved.y,
      button,
      buttons: 0,
      clickCount: 1,
    })
    await sleep(this.#config.settleMs)
    await this.#settle(page)
    return { clicked: resolved.name || resolved.text || resolved.tag, target: describeTarget(target), page: await this.summary(page, 600) }
  }

  /** Focus a field, clear it, and insert text through the protocol. */
  async type(target, text, options = {}) {
    const page = await this.#currentPage()
    const focused = await this.evaluateIn(page, focusExpression(target))
    if (!focused.found) throw new CdpError(`no element matched ${describeTarget(target)}`)
    if (focused.readOnly) throw new CdpError(`element ${focused.name || focused.tag} is read-only or disabled`)
    await page.send('Input.insertText', { text: String(text ?? '') })
    if (options.submit === true) await this.#press(page, 'Enter')
    await sleep(this.#config.settleMs)
    const value = await this.evaluateIn(page, valueExpression(target))
    if (options.submit === true) await this.#settle(page)
    return { typed: String(text ?? ''), field: focused.name || focused.tag, value: value.value, submitted: options.submit === true, page: await this.summary(page, 400) }
  }

  /** Dispatch one key press to the focused element. */
  async press(name) {
    const page = await this.#currentPage()
    await this.#press(page, name)
    await sleep(this.#config.settleMs)
    await this.#settle(page)
    return { pressed: String(name), page: await this.summary(page, 400) }
  }

  async #press(page, name) {
    const spec = keySpec(name)
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk }
    await page.send('Input.dispatchKeyEvent', spec.text !== undefined ? { ...base, type: 'keyDown', text: spec.text } : { ...base, type: 'rawKeyDown' })
    await page.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }

  /** Scroll the page with a wheel event at the viewport center. */
  async scroll(deltaY) {
    const page = await this.#currentPage()
    const delta = Number(deltaY)
    if (!Number.isFinite(delta) || delta === 0) throw new CdpError('deltaY must be a non-zero number')
    const x = Math.round(this.#config.viewportWidth / 2)
    const y = Math.round(this.#config.viewportHeight / 2)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: delta })
    await sleep(this.#config.settleMs)
    return this.evaluateIn(page, scrollExpression())
  }

  /** Capture the viewport or the whole page into a PNG file. */
  async screenshot(options = {}) {
    const page = await this.#currentPage()
    await this.#settle(page)
    let clip
    if (options.fullPage === true) {
      const metrics = await page.send('Page.getLayoutMetrics')
      const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: this.#config.viewportWidth, height: this.#config.viewportHeight }
      clip = {
        x: 0,
        y: 0,
        width: Math.min(Math.ceil(size.width), 4000),
        height: Math.min(Math.ceil(size.height), 8000),
        scale: 1,
      }
    }
    const shot = await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: options.fullPage === true,
      ...(clip ? { clip } : {}),
    })
    const buffer = Buffer.from(shot.data, 'base64')
    const directory = this.#screenshots()
    try { mkdirSync(directory, { recursive: true, mode: 0o700 }) } catch { /* fall through to the write error */ }
    const requested = typeof options.path === 'string' && options.path.length > 0
      ? (this.#config.allowAnyScreenshotPath === true ? path.resolve(options.path) : path.resolve(directory, options.path))
      : path.join(directory, screenshotName())
    const relative = path.relative(directory, requested)
    if (this.#config.allowAnyScreenshotPath !== true && (relative === '' || relative.startsWith('..') || path.isAbsolute(relative))) {
      throw new CdpError(`screenshot path must name a PNG file inside ${directory}; set browser allowAnyScreenshotPath true to override`)
    }
    try { mkdirSync(path.dirname(requested), { recursive: true }) } catch { /* the write reports it */ }
    if (this.#config.allowAnyScreenshotPath !== true) {
      const canonicalDirectory = realpathSync(directory)
      const canonicalParent = realpathSync(path.dirname(requested))
      const escaped = path.relative(canonicalDirectory, canonicalParent)
      if (escaped.startsWith('..') || path.isAbsolute(escaped)) throw new CdpError('screenshot path escapes screenshotDir through a symbolic link')
    }
    writeFileSync(requested, buffer, { flag: 'w' })
    const size = pngSize(buffer)
    return {
      path: requested,
      bytes: buffer.length,
      width: size?.width,
      height: size?.height,
      fullPage: options.fullPage === true,
      url: (await this.summary(page, 200)).url,
    }
  }

  /** List, open, select, or close page tabs. */
  async tabs(action = 'list', index) {
    const client = await this.#connect()
    const { targetInfos } = await client.send('Target.getTargets')
    const pages = targetInfos.filter((info) => info.type === 'page')
    if (action === 'list') {
      return {
        tabs: pages.map((info, position) => ({ index: position, title: info.title, url: info.url, active: info.targetId === this.#active })),
      }
    }
    if (action === 'new') {
      const page = await this.#newTab()
      return { opened: true, tabs: await this.tabs('list'), page: await this.summary(page, 200) }
    }
    const position = Number(index)
    if (!Number.isInteger(position) || position < 0 || position >= pages.length) {
      throw new CdpError(`tab index ${index} is out of range (0-${Math.max(pages.length - 1, 0)})`)
    }
    const target = pages[position]
    if (action === 'select') {
      if (!this.#pages.has(target.targetId)) await this.#attach(target.targetId)
      this.#active = target.targetId
      return { selected: position, page: await this.summary(this.#pages.get(target.targetId), 400) }
    }
    if (action === 'close') {
      await client.send('Target.closeTarget', { targetId: target.targetId })
      this.#pages.delete(target.targetId)
      if (this.#active === target.targetId) this.#active = undefined
      return { closed: position, tabs: await this.tabs('list') }
    }
    throw new CdpError(`unknown tabs action ${action}`)
  }

  /** Stop the browser process, drain queued calls, and remove private state. */
  async dispose() {
    if (this.#disposing) return this.#disposing
    this.#closed = true
    this.#disposing = this.#finish()
    return this.#disposing
  }

  async #finish() {
    // Calls accepted before dispose still drain; calls after it are rejected
    // by run(). Without this wait a late call can relaunch Chromium after the
    // component was unmounted.
    await this.#queue
    const client = this.#client
    const process = this.#process
    this.#client = undefined
    this.#process = undefined
    this.#pages.clear()
    this.#active = undefined
    try { client?.close() } catch { /* already gone */ }
    try { await process?.stop() } catch { /* already gone */ }
    this.#clearTemporaryDirectories()
  }
}
