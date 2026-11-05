/**
 * Proxy lifecycle: node configuration, the local proxy server, the process-wide
 * egress route, persistence, and the connectivity probe.
 *
 * One instance is shared by the Web panel's HTTP actions and the `ss_proxy`
 * agent tool, so both callers exercise the same operations.
 * @module @local/ss-proxy/controller
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { LocalProxy } from './local-proxy.js'
import { installEgress } from './egress.js'
import { METHOD_NAMES, cipherFor, openTunnel } from './shadowsocks.js'
import { parseNodeInput } from './ss-uri.js'

/** Default node fields. */
const DEFAULT_NODE = { server: '', port: 8388, method: 'aes-256-gcm', password: '' }

/** Host suffix list kept direct. */
const DEFAULT_BYPASS = 'localhost,127.0.0.1,::1'

/** Probe used by `test` when the caller names no target. */
const DEFAULT_TEST_TARGET = 'www.gstatic.com:80'

/** Wait between reconnect attempts while a saved route cannot be restored. */
const RETRY_DELAY_MS = 20000

/** Clamp a value into an integer range. */
function integerInRange(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) return fallback
  return number
}

/** Validate a method name, returning its canonical spelling. */
function normalizeMethod(value, fallback) {
  try {
    const method = String(value ?? '').trim().toLowerCase()
    cipherFor(method)
    return method
  } catch {
    if (fallback !== undefined) return fallback
    throw new Error(`unsupported method "${value}" (use ${METHOD_NAMES.join(', ')})`)
  }
}

/** Read `host:port` for the probe. */
function parseTestTarget(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return parseTestTarget(DEFAULT_TEST_TARGET)
  const bracket = /^\[([^\]]+)\]:(\d+)$/.exec(text)
  if (bracket !== null) return { host: bracket[1], port: Number(bracket[2]) }
  const index = text.lastIndexOf(':')
  if (index === -1) return { host: text, port: 80 }
  return { host: text.slice(0, index), port: Number(text.slice(index + 1)) }
}

/** The controller behind both the Web panel and the agent tool. */
export class ProxyController {
  #stateFile
  #log
  #state
  #proxy = null
  #egress = null
  #lastTest = null
  #lastError = null
  #startedAt = null
  #retryTimer = null

  /**
   * @param options.config - the plugin row config, used only as first-run defaults.
   * @param options.log - diagnostic sink.
   */
  constructor({ config = {}, log = () => {} } = {}) {
    this.#log = log
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    this.#stateFile = typeof config.stateFile === 'string' && config.stateFile.length > 0 ? config.stateFile : path.join(home, 'ss-proxy.json')
    this.#state = {
      enabled: false,
      node: {
        server: typeof config.server === 'string' ? config.server : DEFAULT_NODE.server,
        port: integerInRange(config.port, 1, 65535, DEFAULT_NODE.port),
        method: normalizeMethod(config.method, DEFAULT_NODE.method),
        password: typeof config.password === 'string' ? config.password : DEFAULT_NODE.password,
      },
      localPort: integerInRange(config.localPort, 1024, 65535, 17890),
      bypass: typeof config.bypass === 'string' && config.bypass.length > 0 ? config.bypass : DEFAULT_BYPASS,
      autoStart: config.autoStart === true,
    }
  }

  /**
   * Load persisted state and re-establish the route it recorded.
   *
   * The saved password travels with the node, so a restart resumes the same
   * tunnel instead of dropping the user back to direct egress. A node that is
   * unreachable at boot keeps the saved intent and is retried in the
   * background; the intent only changes when the user changes it.
   */
  async init() {
    try {
      const raw = await readFile(this.#stateFile, 'utf8')
      const saved = JSON.parse(raw)
      if (saved !== null && typeof saved === 'object') {
        const node = saved.node ?? {}
        this.#state.node = {
          server: typeof node.server === 'string' && node.server !== '' ? node.server : this.#state.node.server,
          port: integerInRange(node.port, 1, 65535, this.#state.node.port),
          method: normalizeMethod(node.method, this.#state.node.method),
          password: typeof node.password === 'string' ? node.password : this.#state.node.password,
        }
        this.#state.localPort = integerInRange(saved.localPort, 1024, 65535, this.#state.localPort)
        if (typeof saved.bypass === 'string') this.#state.bypass = saved.bypass
        this.#state.enabled = saved.enabled === true
        if (typeof saved.autoStart === 'boolean') this.#state.autoStart = saved.autoStart
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#log(`state file unreadable: ${error.message}`)
    }
    if (!this.#state.enabled && this.#state.autoStart) this.#state.enabled = true
    if (!this.#state.enabled) return
    if (!this.#nodeReady()) {
      this.#lastError = 'the saved node is missing its password or server; enter them to reconnect'
      this.#scheduleRetry()
      return
    }
    try {
      await this.enable()
    } catch (error) {
      this.#lastError = `reconnect at startup failed: ${error.message}`
      this.#log(this.#lastError)
      await this.#teardown()
      // The saved intent survives, so the next boot and the retry timer both
      // keep trying instead of silently switching the user back to direct egress.
      this.#scheduleRetry()
    }
  }

  /** Stop the proxy and restore the previous egress route. */
  async dispose() {
    this.#cancelRetry()
    await this.#teardown()
  }

  /** Retry a pending reconnect in the background while the intent stands. */
  #scheduleRetry() {
    if (this.#retryTimer !== null || !this.#state.enabled) return
    this.#retryTimer = setTimeout(async () => {
      this.#retryTimer = null
      if (!this.#state.enabled || this.#proxy !== null) return
      try {
        if (!this.#nodeReady()) return
        await this.enable()
      } catch (error) {
        this.#lastError = `reconnect failed: ${error.message}`
        this.#scheduleRetry()
      }
    }, RETRY_DELAY_MS)
    this.#retryTimer.unref?.()
  }

  /** Drop a pending reconnect. */
  #cancelRetry() {
    if (this.#retryTimer === null) return
    clearTimeout(this.#retryTimer)
    this.#retryTimer = null
  }

  /** Fail fast when the node's TCP port is unreachable. */
  #probeServer(timeoutMs) {
    const node = this.#state.node
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: node.server, port: node.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`node ${node.server}:${node.port} did not answer within ${timeoutMs} ms`))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.destroy()
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  /** Whether the node has everything a connection needs. */
  #nodeReady() {
    const node = this.#state.node
    return node.server.length > 0 && Number.isInteger(node.port) && node.password.length > 0 && METHOD_NAMES.includes(node.method)
  }

  /** Snapshot for the panel and the tool. */
  state() {
    return {
      enabled: this.#state.enabled,
      running: this.#proxy !== null,
      localPort: this.#state.localPort,
      node: {
        server: this.#state.node.server,
        port: this.#state.node.port,
        method: this.#state.node.method,
        hasPassword: this.#state.node.password.length > 0,
      },
      passwordStored: this.#state.node.password.length > 0,
      bypass: this.#state.bypass,
      methods: METHOD_NAMES,
      stats: this.#proxy?.stats() ?? { active: 0, total: 0, bytesUp: 0, bytesDown: 0, failures: 0 },
      egress: this.#egress === null ? null : { proxyUrl: this.#egress.proxyUrl, noProxy: this.#egress.noProxy },
      lastError: this.#lastError,
      lastTest: this.#lastTest,
      startedAt: this.#startedAt,
      stateFile: this.#stateFile,
    }
  }

  /** Validate and apply a configuration patch. */
  async configure(patch = {}) {
    const previousLocalPort = this.#state.localPort
    const next = { ...this.#state.node }
    if (patch.server !== undefined) {
      const server = String(patch.server).trim()
      if (server.length === 0) throw new Error('server is required')
      next.server = server
    }
    if (patch.port !== undefined) {
      const port = integerInRange(patch.port, 1, 65535, Number.NaN)
      if (Number.isNaN(port)) throw new Error('port must be 1-65535')
      next.port = port
    }
    if (patch.method !== undefined) next.method = normalizeMethod(patch.method)
    if (typeof patch.password === 'string' && patch.password.length > 0) next.password = patch.password
    if (patch.clearPassword === true) next.password = ''
    this.#state.node = next
    if (patch.localPort !== undefined) {
      const localPort = integerInRange(patch.localPort, 1024, 65535, Number.NaN)
      if (Number.isNaN(localPort)) throw new Error('local port must be 1024-65535')
      this.#state.localPort = localPort
    }
    if (typeof patch.bypass === 'string') this.#state.bypass = patch.bypass.trim()
    this.#lastError = null
    await this.#persist()
    if (this.#state.enabled) {
      try {
        if (this.#state.localPort !== previousLocalPort) await this.#teardown()
        await this.enable()
      } catch (error) {
        await this.#teardown()
        this.#state.enabled = false
        await this.#persist()
        throw error
      }
    }
    return this.state()
  }

  /** Forget the stored node and return to the initial state. */
  async reset() {
    this.#cancelRetry()
    await this.#teardown()
    this.#state = {
      enabled: false,
      node: { ...DEFAULT_NODE },
      localPort: this.#state.localPort,
      bypass: DEFAULT_BYPASS,
      autoStart: false,
    }
    this.#lastError = null
    this.#lastTest = null
    await this.#persist()
    return this.state()
  }

  /** Parse an ss:// link or a Clash/subscription JSON config into node fields. */
  parse(input) {
    const node = parseNodeInput(input, METHOD_NAMES)
    return { ...node, method: normalizeMethod(node.method) }
  }

  /** Turn the proxy on for the whole process. */
  async enable() {
    if (!this.#nodeReady()) throw new Error('fill in the Shadowsocks server, port and password first')
    this.#lastError = null
    // Refuse to point every outbound request at a node that cannot be reached.
    if (this.#egress === null) await this.#probeServer(4000)
    if (this.#proxy === null) {
      const proxy = new LocalProxy({
        resolveNode: () => {
          if (!this.#nodeReady()) throw new Error('Shadowsocks node is not configured')
          return this.#state.node
        },
        log: (message) => this.#log(message),
      })
      try {
        await proxy.listen(this.#state.localPort)
      } catch (error) {
        throw new Error(`cannot listen on 127.0.0.1:${this.#state.localPort} — ${error.message}`)
      }
      this.#proxy = proxy
    }
    // Reinstall on every enable so a changed bypass list reaches NO_PROXY at once;
    // disposing first restores the pre-proxy environment the new install captures.
    if (this.#egress !== null) await this.#egress.dispose()
    this.#egress = await installEgress({ port: this.#proxy.port ?? this.#state.localPort, bypass: this.#state.bypass })
    this.#state.enabled = true
    this.#startedAt = new Date().toISOString()
    this.#cancelRetry()
    await this.#persist()
    return this.state()
  }

  /** Turn the proxy off and restore direct egress. */
  async disable() {
    this.#cancelRetry()
    await this.#teardown()
    this.#state.enabled = false
    await this.#persist()
    return this.state()
  }

  /** Stop both halves without touching the persisted `enabled` flag. */
  async #teardown() {
    if (this.#egress !== null) {
      const egress = this.#egress
      this.#egress = null
      await egress.dispose()
    }
    if (this.#proxy !== null) {
      const proxy = this.#proxy
      this.#proxy = null
      await proxy.close()
    }
    this.#startedAt = null
  }

  /**
   * Probe the node with one real HTTP request through a tunnel.
   * @param target - `host:port`, default `www.gstatic.com:80`.
   */
  async test(target) {
    const destination = parseTestTarget(target)
    if (!this.#nodeReady()) throw new Error('configure the Shadowsocks node first')
    const startedAt = Date.now()
    const tunnel = await openTunnel(this.#state.node, destination, { timeoutMs: 10000 })
    try {
      const request = `GET /generate_204 HTTP/1.1\r\nHost: ${destination.host}\r\nUser-Agent: ss-proxy-probe\r\nAccept: */*\r\nConnection: close\r\n\r\n`
      tunnel.write(request)
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for the node response')), 10000)
        let buffer = Buffer.alloc(0)
        const onData = (chunk) => {
          buffer = Buffer.concat([buffer, chunk])
          if (buffer.includes('\r\n\r\n') || buffer.length > 8192) {
            clearTimeout(timer)
            tunnel.off('data', onData)
            resolve(buffer)
          }
        }
        tunnel.on('data', onData)
        tunnel.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      const statusLine = response.toString('latin1').split('\r\n', 1)[0] ?? ''
      const status = Number(/^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine)?.[1] ?? 0)
      this.#lastTest = {
        ok: status > 0,
        status,
        target: `${destination.host}:${destination.port}`,
        ms: Date.now() - startedAt,
        at: new Date().toISOString(),
      }
      return this.#lastTest
    } finally {
      tunnel.destroy()
    }
  }

  /** Persist the state file atomically with owner-only permissions. */
  async #persist() {
    const directory = path.dirname(this.#stateFile)
    const temporary = `${this.#stateFile}.${process.pid}.tmp`
    const payload = JSON.stringify(
      {
        enabled: this.#state.enabled,
        // Kept locally so a restart can resume the same route; the file is 0600
        // and the password never leaves the Host (the panel only sees a flag).
        node: {
          server: this.#state.node.server,
          port: this.#state.node.port,
          method: this.#state.node.method,
          password: this.#state.node.password,
        },
        localPort: this.#state.localPort,
        bypass: this.#state.bypass,
        autoStart: this.#state.autoStart,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporary, `${payload}\n`, { mode: 0o600 })
      await rename(temporary, this.#stateFile)
      await chmod(this.#stateFile, 0o600)
    } catch (error) {
      this.#lastError = `could not save settings: ${error.message}`
      this.#log(this.#lastError)
    }
  }
}
