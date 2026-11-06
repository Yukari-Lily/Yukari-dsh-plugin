/**
 * Proxy lifecycle: the node list, the local proxy server, the process-wide
 * egress route, persistence, and the connectivity probe.
 *
 * One instance is shared by the Web panel's HTTP actions and the `ss_proxy`
 * agent tool, so both callers exercise the same operations.
 * @module @local/ss-proxy/controller
 */
import crypto from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { LocalProxy } from './local-proxy.js'
import { installEgress } from './egress.js'
import { METHOD_NAMES, cipherFor, openTunnel } from './shadowsocks.js'
import { parseNodeInput, parseNodesInput } from './ss-uri.js'

/** Default node fields. */
const DEFAULT_NODE = { server: '', port: 8388, method: 'aes-256-gcm', password: '' }

/** Host suffix list kept direct. */
const DEFAULT_BYPASS = 'localhost,127.0.0.1,::1'

/** Probe used by `test` when the caller names no target. */
const DEFAULT_TEST_TARGET = 'www.gstatic.com:80'

/** Nodes probed at once by `testAll`. */
const TEST_CONCURRENCY = 4

/** How often an enabled route re-checks the active node on its own. */
const WATCHDOG_INTERVAL_MS = 60000

/** Failed checks in a row before an enabled route closes itself. */
const WATCHDOG_FAILURES = 2

/** Proxy variables a previous process may have left behind. */
const EGRESS_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']

/** Loopback host names that mean "this process's own proxy". */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1'])

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

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** Whether two nodes reach the same server with the same credentials. */
const sameNode = (a, b) => a.server === b.server && a.port === b.port && a.method === b.method && a.password === b.password

/** The controller behind both the Web panel and the agent tool. */
export class ProxyController {
  #stateFile
  #log
  #state
  #proxy = null
  #egress = null
  #lastTest = null
  #nodeTests = new Map()
  #lastError = null
  #startedAt = null
  #shutdown = null
  #proxyGeneration = 0
  #probeThroughOverride = null
  #watchdogTimer = null
  #watchdogFailures = 0
  #watchdogInterval = WATCHDOG_INTERVAL_MS

  /**
   * @param options.config - the plugin row config, used only as first-run defaults.
   * @param options.log - diagnostic sink.
   * @param options.probeThrough - optional test override for the real tunnel probe.
   * @param options.watchdogIntervalMs - optional health-check interval override.
   */
  constructor({ config = {}, log = () => {}, probeThrough, watchdogIntervalMs } = {}) {
    this.#log = log
    this.#probeThroughOverride = typeof probeThrough === 'function' ? probeThrough : null
    const interval = Number(watchdogIntervalMs)
    if (Number.isFinite(interval) && interval > 0) this.#watchdogInterval = interval
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    this.#stateFile = typeof config.stateFile === 'string' && config.stateFile.length > 0 ? config.stateFile : path.join(home, 'ss-proxy.json')
    const nodes = []
    if (typeof config.server === 'string' && config.server.trim().length > 0) {
      nodes.push({
        id: this.#newId(nodes),
        name: config.server.trim(),
        server: config.server.trim(),
        port: integerInRange(config.port, 1, 65535, DEFAULT_NODE.port),
        method: normalizeMethod(config.method, DEFAULT_NODE.method),
        password: typeof config.password === 'string' ? config.password : DEFAULT_NODE.password,
      })
    }
    this.#state = {
      enabled: false,
      activeId: nodes[0]?.id ?? null,
      nodes,
      localPort: integerInRange(config.localPort, 1024, 65535, 17890),
      bypass: typeof config.bypass === 'string' && config.bypass.length > 0 ? config.bypass : DEFAULT_BYPASS,
      autoStart: config.autoStart === true,
    }
  }

  /**
   * Load persisted state and re-establish the route it recorded.
   *
   * The saved password travels with each node, so a restart resumes the same
   * tunnel instead of dropping the user back to direct egress. Invalid or
   * unreachable configuration turns the saved intent off: never leave every
   * outbound request pointed at a route that is known to be broken.
   */
  async init() {
    let migrated = false
    // A restart keeps the environment: clear a dead route before reading anything.
    this.#clearInheritedEgress()
    try {
      const raw = await readFile(this.#stateFile, 'utf8')
      const saved = JSON.parse(raw)
      if (saved !== null && typeof saved === 'object') {
        if (Array.isArray(saved.nodes)) {
          const nodes = []
          for (const entry of saved.nodes) {
            const node = this.#savedNode(entry, nodes)
            if (node !== null) nodes.push(node)
          }
          this.#state.nodes = nodes
          this.#state.activeId = typeof saved.activeId === 'string' ? saved.activeId : null
        } else if (typeof saved.node?.server === 'string' && saved.node.server.trim() !== '') {
          // Legacy single-node file: the node becomes the first, active entry.
          const node = this.#savedNode({ ...saved.node, name: saved.node.server }, [])
          this.#state.nodes = [node]
          this.#state.activeId = node.id
          migrated = true
        }
        this.#state.localPort = integerInRange(saved.localPort, 1024, 65535, this.#state.localPort)
        if (typeof saved.bypass === 'string') this.#state.bypass = saved.bypass
        this.#state.enabled = saved.enabled === true
        if (typeof saved.autoStart === 'boolean') this.#state.autoStart = saved.autoStart
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#log(`state file unreadable: ${error.message}`)
    }
    this.#ensureActive()
    // The saved port may differ from the configured one; clear that spelling too.
    this.#clearInheritedEgress()
    if (migrated) await this.#persist()
    if (!this.#state.enabled && this.#state.autoStart) this.#state.enabled = true
    if (!this.#state.enabled) return
    if (!this.#nodeReady()) {
      await this.#failClosed('the saved node is missing its password or server; enter a valid node and enable again')
      return
    }
    try {
      await this.enable()
    } catch (error) {
      await this.#failClosed(`reconnect at startup failed: ${messageOf(error)}`)
    }
  }

  /** Stop the proxy and restore the previous egress route. */
  async dispose() {
    await this.#teardown()
  }

  /** Sanitize one persisted node; null when it has no server. */
  #savedNode(entry, existing) {
    if (entry === null || typeof entry !== 'object') return null
    const server = typeof entry.server === 'string' ? entry.server.trim() : ''
    if (server.length === 0) return null
    const id = typeof entry.id === 'string' && entry.id.length > 0 && !existing.some((node) => node.id === entry.id) ? entry.id : this.#newId(existing)
    return {
      id,
      name: typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : server,
      server,
      port: integerInRange(entry.port, 1, 65535, DEFAULT_NODE.port),
      method: normalizeMethod(entry.method, DEFAULT_NODE.method),
      password: typeof entry.password === 'string' ? entry.password : '',
    }
  }

  /** A short id not used by any node. */
  #newId(nodes = this.#state.nodes) {
    let id = crypto.randomUUID().slice(0, 8)
    while (nodes.some((node) => node.id === id)) id = crypto.randomUUID().slice(0, 8)
    return id
  }

  /** The active node, or null. */
  #active() {
    return this.#state.nodes.find((node) => node.id === this.#state.activeId) ?? null
  }

  /** The node with this id; throws when there is none. */
  #find(id) {
    if (id === undefined || id === null || String(id) === '') throw new Error('node id is required')
    const node = this.#state.nodes.find((entry) => entry.id === String(id))
    if (node === undefined) throw new Error(`unknown node "${id}"`)
    return node
  }

  /** Keep `activeId` pointing at an existing node whenever there is one. */
  #ensureActive() {
    if (this.#active() === null) this.#state.activeId = this.#state.nodes[0]?.id ?? null
  }

  /**
   * Restore direct egress and persist the off state after any route failure.
   * Concurrent tunnel errors share one shutdown; stale proxy generations are ignored.
   */
  async #failClosed(reason) {
    if (this.#shutdown !== null) return this.#shutdown
    this.#shutdown = (async () => {
      this.#lastError = `proxy disabled automatically: ${reason}`
      this.#log(this.#lastError)
      try {
        await this.#teardown()
      } finally {
        this.#state.enabled = false
        await this.#persist()
      }
    })()
    try {
      await this.#shutdown
    } finally {
      this.#shutdown = null
    }
  }

  /** A live tunnel failed; only its own current generation may shut the route down. */
  async #proxyFailed(generation, error) {
    if (generation !== this.#proxyGeneration || this.#proxy === null || !this.#state.enabled) return
    await this.#failClosed(messageOf(error))
  }

  /**
   * Drop proxy variables that point at our own local port while no proxy of
   * this process is listening. An `execve` restart keeps the environment, so a
   * route installed by the previous process would otherwise send every
   * outbound request into a port that no longer exists.
   * @returns the names that were cleared.
   */
  #clearInheritedEgress() {
    const port = String(this.#state.localPort)
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
      if (!LOOPBACK_NAMES.has(url.hostname.replace(/^\[|\]$/g, '').toLowerCase())) continue
      if (String(url.port) !== port) continue
      Reflect.deleteProperty(process.env, name)
      cleared.push(name)
    }
    if (cleared.length === 0) return cleared
    Reflect.deleteProperty(process.env, 'NODE_USE_ENV_PROXY')
    this.#log(`cleared inherited proxy settings (${cleared.join(', ')}) pointing at 127.0.0.1:${port} while no proxy was running`)
    return cleared
  }

  /** Re-check the active node on a timer so a route that dies between requests still closes. */
  #startWatchdog() {
    this.#stopWatchdog()
    this.#watchdogTimer = setInterval(() => {
      void this.#watchdogTick()
    }, this.#watchdogInterval)
    this.#watchdogTimer.unref?.()
  }

  /** Drop the health-check timer. */
  #stopWatchdog() {
    if (this.#watchdogTimer !== null) {
      clearInterval(this.#watchdogTimer)
      this.#watchdogTimer = null
    }
    this.#watchdogFailures = 0
  }

  /** One health check: two failures in a row close the route. */
  async #watchdogTick() {
    if (!this.#state.enabled || this.#proxy === null) {
      this.#stopWatchdog()
      return
    }
    const node = this.#active()
    if (!this.#nodeReady(node)) {
      await this.#failClosed('the active node lost the fields a connection needs')
      return
    }
    try {
      const probe = await this.#probeThrough(node, parseTestTarget(DEFAULT_TEST_TARGET))
      if (probe?.ok !== true) throw new Error(`probe returned HTTP ${probe?.status ?? 0}`)
      this.#watchdogFailures = 0
    } catch (error) {
      this.#watchdogFailures += 1
      this.#log(`proxy health check failed (${this.#watchdogFailures}/${WATCHDOG_FAILURES}): ${messageOf(error)}`)
      if (this.#watchdogFailures >= WATCHDOG_FAILURES) await this.#failClosed(`health checks failed: ${messageOf(error)}`)
    }
  }

  /** Whether a node (default the active one) has everything a connection needs. */
  #nodeReady(node = this.#active()) {
    if (node === null) return false
    return node.server.length > 0 && Number.isInteger(node.port) && node.password.length > 0 && METHOD_NAMES.includes(node.method)
  }

  /** Snapshot for the panel and the tool; passwords never leave the Host. */
  state() {
    const active = this.#active()
    return {
      enabled: this.#state.enabled,
      running: this.#proxy !== null,
      localPort: this.#state.localPort,
      node:
        active === null
          ? { server: DEFAULT_NODE.server, port: DEFAULT_NODE.port, method: DEFAULT_NODE.method, hasPassword: false }
          : { server: active.server, port: active.port, method: active.method, hasPassword: active.password.length > 0 },
      passwordStored: active !== null && active.password.length > 0,
      activeId: active?.id ?? null,
      nodes: this.#state.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        server: node.server,
        port: node.port,
        method: node.method,
        hasPassword: node.password.length > 0,
        active: node === active,
        lastTest: this.#nodeTests.get(node.id) ?? null,
      })),
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

  /**
   * Validate and apply a configuration patch.
   *
   * `patch.id` picks the node to edit (default the active one); with no nodes
   * at all, a `server` creates the first one. `localPort` and `bypass` are global.
   */
  async configure(patch = {}) {
    const previousLocalPort = this.#state.localPort
    const target = patch.id !== undefined && patch.id !== null && patch.id !== '' ? this.#find(patch.id) : this.#active()
    let next = null
    if (target !== null || patch.server !== undefined) {
      next = target === null ? { id: this.#newId(), name: '', ...DEFAULT_NODE } : { ...target }
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
      if (typeof patch.name === 'string') next.name = patch.name.trim()
      if (next.name.length === 0) next.name = next.server
    }
    let localPort = this.#state.localPort
    if (patch.localPort !== undefined) {
      localPort = integerInRange(patch.localPort, 1024, 65535, Number.NaN)
      if (Number.isNaN(localPort)) throw new Error('local port must be 1024-65535')
    }
    if (next !== null) {
      if (target === null) {
        this.#state.nodes.push(next)
      } else {
        if (!sameNode(target, next)) this.#nodeTests.delete(target.id)
        this.#state.nodes[this.#state.nodes.indexOf(target)] = next
      }
      this.#ensureActive()
    }
    this.#state.localPort = localPort
    if (typeof patch.bypass === 'string') this.#state.bypass = patch.bypass.trim()
    this.#lastError = null
    await this.#persist()
    if (this.#state.enabled) {
      try {
        if (this.#state.localPort !== previousLocalPort) await this.#teardown()
        await this.enable()
      } catch (error) {
        await this.#failClosed(`configuration failed: ${messageOf(error)}`)
        throw error
      }
    }
    return this.state()
  }

  /**
   * Add every node found in pasted text (links, subscription, Clash YAML, JSON).
   * A node already stored with the same server, port, method and password only
   * has its name refreshed.
   * @returns `{ added, updated, skipped, state }`.
   */
  async importNodes(text) {
    const parsed = parseNodesInput(text, METHOD_NAMES)
    let added = 0
    let updated = 0
    let first = null
    for (const entry of parsed.nodes) {
      const candidate = {
        server: entry.server.trim(),
        port: entry.port,
        method: normalizeMethod(entry.method),
        password: entry.password,
      }
      const name = typeof entry.name === 'string' ? entry.name.trim() : ''
      let node = this.#state.nodes.find((existing) => sameNode(existing, candidate))
      if (node === undefined) {
        node = { id: this.#newId(), name: name || `${candidate.server}:${candidate.port}`, ...candidate }
        this.#state.nodes.push(node)
        added += 1
      } else {
        if (name.length > 0) node.name = name
        updated += 1
      }
      first ??= node
    }
    if (this.#active() === null && first !== null) this.#state.activeId = first.id
    this.#lastError = null
    await this.#persist()
    return { added, updated, skipped: parsed.skipped, state: this.state() }
  }

  /**
   * Make a node the active one. While the proxy is on, a real request probes
   * the new node first; a failure restores direct egress instead of stranding
   * the process on an enabled but unusable route.
   */
  async select(id) {
    const node = this.#find(id)
    if (node === this.#active()) return this.state()
    if (this.#state.enabled) {
      try {
        if (!this.#nodeReady(node)) throw new Error(`node "${node.name}" is missing its server or password`)
        await this.#probeThrough(node, parseTestTarget(DEFAULT_TEST_TARGET))
      } catch (error) {
        await this.#failClosed(`node selection failed: ${messageOf(error)}`)
        throw error
      }
    }
    // New connections pick the node up through `resolveNode`; open ones finish on the old node.
    this.#state.activeId = node.id
    this.#lastTest = this.#nodeTests.get(node.id) ?? null
    this.#lastError = null
    await this.#persist()
    if (this.#state.enabled && this.#proxy === null) {
      try {
        await this.enable()
      } catch (error) {
        await this.#failClosed(`reconnect failed: ${messageOf(error)}`)
        throw error
      }
    }
    return this.state()
  }

  /** Remove a node; removing the last one while enabled turns the proxy off. */
  async removeNode(id) {
    const node = this.#find(id)
    const wasActive = node === this.#active()
    this.#state.nodes = this.#state.nodes.filter((entry) => entry !== node)
    this.#nodeTests.delete(node.id)
    if (wasActive) {
      this.#state.activeId = null
      this.#lastTest = null
    }
    this.#ensureActive()
    if (this.#state.nodes.length === 0 && this.#state.enabled) {
      await this.#teardown()
      this.#state.enabled = false
    }
    await this.#persist()
    return this.state()
  }

  /** Forget every stored node and return to the initial state. */
  async reset() {
    await this.#teardown()
    this.#state = {
      enabled: false,
      activeId: null,
      nodes: [],
      localPort: this.#state.localPort,
      bypass: DEFAULT_BYPASS,
      autoStart: false,
    }
    this.#lastError = null
    this.#lastTest = null
    this.#nodeTests.clear()
    await this.#persist()
    return this.state()
  }

  /** Parse an ss:// link or a Clash/subscription config into the first node's fields. */
  parse(input) {
    const node = parseNodeInput(input, METHOD_NAMES)
    return { ...node, method: normalizeMethod(node.method) }
  }

  /** Turn the proxy on for the whole process, routed through the active node. */
  async enable() {
    const node = this.#active()
    if (node === null) throw new Error('add a Shadowsocks node first')
    if (!this.#nodeReady(node)) throw new Error('fill in the Shadowsocks server, port and password first')
    this.#lastError = null
    try {
      // TCP reachability alone accepts wrong passwords and non-SS servers. Prove
      // a full request before taking over egress whenever a route is installed.
      if (this.#egress === null) {
        const probe = await this.#probeThrough(node, parseTestTarget(DEFAULT_TEST_TARGET))
        if (probe?.ok !== true) throw new Error(`node probe returned HTTP ${probe?.status ?? 0}`)
      }
      if (this.#proxy === null) {
        const generation = ++this.#proxyGeneration
        const proxy = new LocalProxy({
          resolveNode: () => {
            const active = this.#active()
            if (!this.#nodeReady(active)) throw new Error('Shadowsocks node is not configured')
            return active
          },
          log: (message) => this.#log(message),
          onFailure: (error) => this.#proxyFailed(generation, error),
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
      this.#startWatchdog()
      await this.#persist()
      return this.state()
    } catch (error) {
      await this.#failClosed(messageOf(error))
      throw error
    }
  }

  /** Turn the proxy off and restore direct egress. */
  async disable() {
    await this.#teardown()
    this.#state.enabled = false
    await this.#persist()
    return this.state()
  }

  /** Stop both halves without touching the persisted `enabled` flag. */
  async #teardown() {
    this.#stopWatchdog()
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
   * Probe a node with one real HTTP request through a tunnel.
   * @param target - `host:port`, default `www.gstatic.com:80`.
   * @param id - node to test, default the active one.
   */
  async test(target, id) {
    const destination = parseTestTarget(target)
    const node = id !== undefined && id !== null && id !== '' ? this.#find(id) : this.#active()
    if (node === null) throw new Error('configure the Shadowsocks node first')
    try {
      if (!this.#nodeReady(node)) throw new Error('configure the Shadowsocks node first')
      const result = await this.#probeThrough(node, destination)
      this.#recordTest(node, result)
      if (node === this.#active()) this.#lastTest = result
      return result
    } catch (error) {
      this.#recordTest(node, { ok: false, error: messageOf(error), at: new Date().toISOString() })
      if (node === this.#active() && this.#state.enabled) await this.#failClosed(`active node probe failed: ${messageOf(error)}`)
      throw error
    }
  }

  /** Test every node, at most {@link TEST_CONCURRENCY} at a time; never throws. */
  async testAll(target) {
    const queue = [...this.#state.nodes]
    const worker = async () => {
      while (queue.length > 0) {
        const node = queue.shift()
        try {
          await this.test(target, node.id)
        } catch {
          // Recorded on the node by `test`.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(TEST_CONCURRENCY, queue.length) }, worker))
    return this.state()
  }

  /** Keep a node's last result while it still exists. */
  #recordTest(node, result) {
    if (this.#state.nodes.includes(node)) this.#nodeTests.set(node.id, result)
  }

  /** One `GET /generate_204` through a fresh tunnel to the node. */
  async #probeThrough(node, destination) {
    if (this.#probeThroughOverride !== null) return this.#probeThroughOverride(node, destination)
    const startedAt = Date.now()
    const tunnel = await openTunnel(node, destination, { timeoutMs: 10000 })
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
      return {
        ok: status > 0,
        status,
        target: `${destination.host}:${destination.port}`,
        ms: Date.now() - startedAt,
        at: new Date().toISOString(),
      }
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
        activeId: this.#state.activeId,
        // Kept locally so a restart can resume the same route; the file is 0600
        // and passwords never leave the Host (the panel only sees a flag).
        nodes: this.#state.nodes.map((node) => ({
          id: node.id,
          name: node.name,
          server: node.server,
          port: node.port,
          method: node.method,
          password: node.password,
        })),
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
