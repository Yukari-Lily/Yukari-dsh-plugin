/**
 * One lazily started Chromium instance shared by every browser tool.
 *
 * The manager owns the process, the DevTools connection, the active page
 * session, and a serial queue so overlapping tool calls cannot interleave
 * half-finished interactions.
 * @module @local/browser-control/browser
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpClient, CdpError, launchChromium, sleep } from './cdp.js'
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

  /**
   * @param config - the plugin row config, already normalized by the caller.
   * @param runtime - shared automatic Chromium installer.
   */
  constructor(config, runtime) {
    this.#config = config
    this.#runtime = runtime
  }

  /** Run an operation exclusively, so two tool calls never interleave. */
  run(operation) {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Whether a browser process is currently running. */
  get running() {
    return this.#process !== undefined && this.#client?.open === true
  }

  /** Start the browser on first use and return the shared connection. */
  async #connect() {
    if (this.running) return this.#client
    if (this.#starting) return this.#starting
    this.#starting = this.#launch()
    try {
      return await this.#starting
    } finally {
      this.#starting = undefined
    }
  }

  async #launch() {
    const config = this.#config
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
    const userDataDir = config.userDataDir ?? path.join(tmpdir(), `dsh-browser-profile-${process.pid}`)
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
    const launched = await launchChromium({ executablePath, args, env, timeoutMs: config.startTimeoutMs })
    this.#process = launched
    const client = await CdpClient.connect(launched.endpoint, config.startTimeoutMs)
    this.#client = client
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
    return client
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
    if (!/^(https?|file|data|about):$/u.test(parsed.protocol)) {
      throw new CdpError(`unsupported URL protocol ${parsed.protocol}`)
    }
    if (this.#config.allowLocalUrls !== true && (parsed.protocol === 'file:' || parsed.protocol === 'data:')) {
      throw new CdpError(`${parsed.protocol} URLs are disabled; set browser allowLocalUrls true only when local content is trusted`)
    }
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
    const directory = this.#config.screenshotDir
    try { mkdirSync(directory, { recursive: true }) } catch { /* fall through to the write error */ }
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

  /** Stop the browser process and drop its connection. */
  async dispose() {
    try { this.#client?.close() } catch { /* ignore */ }
    this.#client = undefined
    this.#pages.clear()
    this.#active = undefined
    const process = this.#process
    this.#process = undefined
    try { await process?.stop() } catch { /* ignore */ }
  }
}
