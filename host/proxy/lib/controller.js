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
import { appError } from '../../shared/http.js'

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

/** Retry schedule for the reconnect a restart performs on its own behalf. */
const RESTORE_RETRY_MS = [0, 2000, 8000, 20000]

/** Failed checks in a row before an enabled route closes itself; one reset is not a verdict. */
const WATCHDOG_FAILURES = 3

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
  /** Set while the listener forwards straight out instead of through the node. */
  #direct = false
  /** Why the listener could not bind, when it could not. */
  #listenerError = null
  /** The reconnect a restart started on its own; null when none is running. */
  #restoring = null
  /** Set by `dispose`: in-flight retries stop instead of holding the process. */
  #closed = false
  /** Wakes the retry loop early so a restart is not held by a pending timer. */
  #abortWaiters = new Set()
  /** Public mutations run one at a time; the panel and the tool share this controller. */
  #queue = Promise.resolve()
  /** Why the state file must not be written, when it must not. */
  #stateWriteBlocked = null
  #restoreRetryMs = RESTORE_RETRY_MS
  #watchdogInterval = WATCHDOG_INTERVAL_MS

  /**
   * @param options.config - the plugin row config, used only as first-run defaults.
   * @param options.log - diagnostic sink.
   * @param options.probeThrough - optional test override for the real tunnel probe.
   * @param options.watchdogIntervalMs - optional health-check interval override.
   * @param options.restoreRetryMs - optional startup reconnect schedule override.
   */
  constructor({ config = {}, log = () => {}, probeThrough, watchdogIntervalMs, restoreRetryMs } = {}) {
    this.#log = log
    if (Array.isArray(restoreRetryMs) && restoreRetryMs.length > 0) this.#restoreRetryMs = restoreRetryMs.map(Number)
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
      if (error?.code !== 'ENOENT') await this.#setAsideCorruptState(error)
    }
    this.#ensureActive()
    // The saved port may differ from the configured one; clear that spelling too.
    this.#clearInheritedEgress()
    if (migrated) {
      // A failed save must not abort the load: the state in memory is usable.
      await this.#persist().catch((error) => this.#log(messageOf(error)))
    }
    if (!this.#state.enabled && this.#state.autoStart) this.#state.enabled = true
    if (!this.#state.enabled) {
      // The route is off, but a host may still pin child processes to this port
      // (its proxy environment was captured at boot). Listening in direct mode
      // turns those into plain requests instead of connection failures.
      this.#direct = true
      await this.#ensureListener().catch((error) => this.#log(`direct listener unavailable: ${messageOf(error)}`))
      return
    }
    if (!this.#nodeReady()) {
      await this.#failClosed('the saved node is missing its password or server; enter a valid node and enable again')
      return
    }
    // A restart's reconnect races the network and the node itself; one reset is
    // not a decision. Keep the saved intent and retry in the background, so boot
    // neither waits for the probe nor turns the route off behind the user's back.
    this.#restoring = this.#restore()
  }

  /**
   * Move a state file that could not be parsed out of the way.
   *
   * The file holds every node together with its password. Continuing with an
   * empty list and letting the next write replace the file would destroy them
   * permanently, so the bytes stay on disk under a timestamped name and the
   * user is told why the node list came back empty.
   */
  async #setAsideCorruptState(error) {
    const backup = `${this.#stateFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      await rename(this.#stateFile, backup)
      this.#lastError = `状态文件无法解析，已备份为 ${path.basename(backup)}：${messageOf(error)}`
    } catch (renameError) {
      // A new file now would overwrite the only copy; refuse to write at all.
      this.#stateWriteBlocked = `状态文件无法解析且无法备份（${messageOf(renameError)}），已停止写入以免覆盖原文件`
      this.#lastError = this.#stateWriteBlocked
    }
    this.#log(this.#lastError)
  }

  /**
   * Retry the startup reconnect, keeping `enabled` whatever happens.
   * @returns whether the route came back.
   */
  async #restore() {
    let lastError = null
    for (const delay of this.#restoreRetryMs) {
      if (this.#closed) return false
      if (delay > 0) await this.#pause(delay)
      if (this.#closed) return false
      try {
        // Route through the queue: this reconnect must not race a panel click.
        await this.#serialized(() => this.#enableRoute({ keepIntent: true }))
        this.#lastError = null
        return true
      } catch (error) {
        lastError = error
        this.#log(`reconnect attempt failed: ${messageOf(error)}`)
      }
    }
    this.#lastError = `启动时重连失败，已保留启用状态（${messageOf(lastError)}）；可在面板重试`
    await this.#persist().catch((error) => this.#log(messageOf(error)))
    return false
  }

  /** A delay that ends early when the component is disposed. */
  #pause(ms) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        this.#abortWaiters.delete(finish)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      if (this.#closed) finish()
      else this.#abortWaiters.add(finish)
    })
  }

  /** Wait for the reconnect a restart started on its own. */
  async settle() {
    if (this.#restoring === null) return this.#proxy !== null
    return this.#restoring
  }

  /** Stop the proxy and restore the previous egress route. */
  async dispose() {
    this.#closed = true
    for (const wake of [...this.#abortWaiters]) wake()
    // An enable can be mid-flight for as long as its probe takes. Tearing down
    // first would leave the egress and watchdog it installs behind, still
    // pointing the whole process at a listener that is about to close.
    await this.#restoring?.catch(() => undefined)
    await this.#queue
    await this.#teardown()
  }

  /**
   * Run one public mutation at a time.
   *
   * The panel and the `ss_proxy` tool share this controller, so two enables can
   * arrive together. Without the queue the second one tries to bind the port the
   * first just bound, fails with EADDRINUSE, and that failure used to clear and
   * persist `enabled`.
   */
  #serialized(operation) {
    const run = this.#queue.then(() => {
      if (this.#closed) throw new Error('代理组件正在卸载，已放弃本次操作')
      return operation()
    })
    // The queue itself must never stay rejected, or every later call would fail.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Refuse work that a dispose already started. */
  #assertOpen() {
    if (this.#closed) throw new Error('代理组件正在卸载，已放弃本次操作')
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
    if (node === undefined) throw appError(`unknown node "${id}"`, 'proxy-node-unknown')
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
    // The component is going away; dispose restores direct egress itself and
    // an unloaded component must not rewrite the state file.
    if (this.#closed) return
    if (this.#shutdown !== null) return this.#shutdown
    this.#shutdown = (async () => {
      this.#lastError = `proxy disabled automatically: ${reason}`
      this.#log(this.#lastError)
      try {
        // Keep the listener: direct mode is what a child pinned to this port needs.
        await this.#goDirect()
      } finally {
        // 先落盘再翻内存：面板看到「已关闭」时磁盘也已经是关闭的，进程在两步之间死掉
        // 也不会让重启按文件里的 enabled 把这条失效的路由复活。翻转仍然放在 finally 里，
        // 写盘失败时面板照样不会声称路由还在。
        try {
          await this.#persist({ enabled: false })
        } finally {
          this.#state.enabled = false
        }
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
    if (this.#direct || generation !== this.#proxyGeneration || this.#proxy === null || !this.#state.enabled) return
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
      // Nothing awaits a timer callback: a rejected tick would surface as an
      // unhandled rejection instead of a log line.
      this.#watchdogTick().catch((error) => this.#log(`proxy health check crashed: ${messageOf(error)}`))
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
    try {
      if (this.#closed) {
        this.#stopWatchdog()
        return
      }
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
    } catch (error) {
      // A shutdown that could not save its state is not a reason to throw out
      // of a timer; the next tick re-evaluates the route.
      this.#log(`proxy health check crashed: ${messageOf(error)}`)
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
      running: this.#proxy !== null && !this.#direct,
      // A listener that forwards straight out: the port is up, the node is not used.
      direct: this.#proxy !== null && this.#direct,
      listenerError: this.#listenerError,
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
    return this.#serialized(() => this.#configure(patch))
  }

  /** @see configure */
  async #configure(patch) {
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
      if (Number.isNaN(localPort)) throw appError('local port must be 1024-65535', 'proxy-port-invalid')
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
        await this.#enableRoute({ keepIntent: false })
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
    return this.#serialized(() => this.#importNodes(text))
  }

  /** @see importNodes */
  async #importNodes(text) {
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
    return this.#serialized(() => this.#select(id))
  }

  /** @see select */
  async #select(id) {
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
        await this.#enableRoute({ keepIntent: false })
      } catch (error) {
        await this.#failClosed(`reconnect failed: ${messageOf(error)}`)
        throw error
      }
    }
    return this.state()
  }

  /** Remove a node; removing the last one while enabled turns the proxy off. */
  async removeNode(id) {
    return this.#serialized(() => this.#removeNode(id))
  }

  /** @see removeNode */
  async #removeNode(id) {
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
    return this.#serialized(() => this.#reset())
  }

  /** @see reset */
  async #reset() {
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
    return this.#serialized(() => this.#enableRoute({ keepIntent: false }))
  }

  /**
   * Bring the route up.
   * @param options.keepIntent - a failure must not clear the saved "enabled":
   *   the user asked for the route, and one reset from the node is no reason to
   *   forget that. Only a reconnect at startup passes true.
   */
  async #enableRoute({ keepIntent }) {
    const node = this.#active()
    if (node === null) throw appError('add a Shadowsocks node first', 'proxy-no-nodes')
    if (!this.#nodeReady(node)) throw appError('fill in the Shadowsocks server, port and password first', 'proxy-node-incomplete')
    this.#lastError = null
    try {
      // TCP reachability alone accepts wrong passwords and non-SS servers. Prove
      // a full request before taking over egress whenever a route is installed.
      if (this.#egress === null) {
        const probe = await this.#probeThrough(node, parseTestTarget(DEFAULT_TEST_TARGET))
        if (probe?.ok !== true) throw new Error(`node probe returned HTTP ${probe?.status ?? 0}`)
      }
      this.#assertOpen()
      await this.#ensureListener()
      this.#assertOpen()
      // Reinstall on every enable so a changed bypass list reaches NO_PROXY at once;
      // disposing first restores the pre-proxy environment the new install captures.
      if (this.#egress !== null) await this.#egress.dispose()
      this.#egress = await installEgress({ port: this.#proxy.port ?? this.#state.localPort, bypass: this.#state.bypass })
      // A dispose that landed during the install owns the teardown; leaving the
      // egress behind would keep every request pointed at a closing port.
      this.#assertOpen()
      this.#direct = false
      this.#state.enabled = true
      this.#startedAt = new Date().toISOString()
      this.#startWatchdog()
      await this.#persist()
      return this.state()
    } catch (error) {
      // Unloading is not a route failure: dispose disposes what this attempt
      // installed, and the state file must not record anything.
      if (this.#closed) throw error
      if (keepIntent) {
        // Leave nothing half-installed, but keep `enabled` so the next attempt
        // or the next restart can still resume it.
        await this.#goDirect()
        throw error
      }
      await this.#failClosed(messageOf(error))
      throw error
    }
  }

  /** Turn the proxy off and restore direct egress. */
  async disable() {
    return this.#serialized(() => this.#disable())
  }

  /** @see disable */
  async #disable() {
    await this.#goDirect()
    this.#state.enabled = false
    await this.#persist()
    return this.state()
  }

  /**
   * Bring the local listener up, in whichever mode the route is in.
   *
   * The listener stays up while the route is off: a host pins its children to
   * `HTTP_PROXY` at boot, so a closed port here means every child loses its
   * network instead of falling back to direct egress.
   * @throws when the port cannot be bound.
   */
  async #ensureListener() {
    if (this.#proxy !== null) return
    const generation = ++this.#proxyGeneration
    const proxy = new LocalProxy({
      resolveNode: () => {
        if (this.#direct) return null
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
      this.#listenerError = `cannot listen on 127.0.0.1:${this.#state.localPort} — ${error.message}`
      throw appError(`cannot listen on 127.0.0.1:${this.#state.localPort} — ${error.message}`, 'proxy-port-busy', { port: this.#state.localPort })
    }
    this.#listenerError = null
    this.#proxy = proxy
  }

  /** Route the listener straight out and give the Host's own egress back. */
  async #goDirect() {
    this.#stopWatchdog()
    if (this.#egress !== null) {
      const egress = this.#egress
      this.#egress = null
      await egress.dispose()
    }
    this.#direct = true
    this.#startedAt = null
    this.#clearInheritedEgress()
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
    this.#direct = false
    this.#startedAt = null
    // Disposing the egress restores whatever was there before, but a variable
    // that points at our own port is dead either way: leaving it behind sends
    // every child process (git, pnpm, Chromium) into a socket nobody listens on.
    this.#clearInheritedEgress()
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

  /** Build the error a failed save reports; the `code` keeps the route at 500. */
  #saveFailure(message, cause) {
    const failure = new Error(message)
    failure.code = typeof cause?.code === 'string' && cause.code !== '' ? cause.code : 'EPERSIST'
    return failure
  }

  /**
   * Persist the state file atomically with owner-only permissions.
   *
   * @param {object|null} overrides 只对本次落盘生效的字段，用于「先写盘、再翻内存」。
   * @throws when the file cannot be written: the change then exists only in
   *   memory, and reporting success would let the panel claim it was saved.
   */
  async #persist(overrides = null) {
    // An unloaded component must not touch the state file any more.
    if (this.#closed) return
    if (this.#stateWriteBlocked !== null) throw this.#saveFailure(this.#stateWriteBlocked)
    const directory = path.dirname(this.#stateFile)
    // A random suffix keeps two saves from renaming over each other's temporary.
    const temporary = `${this.#stateFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    const payload = JSON.stringify(
      {
        enabled: overrides?.enabled ?? this.#state.enabled,
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
      const failure = this.#saveFailure(`无法保存代理设置：${messageOf(error)}`, error)
      this.#lastError = failure.message
      this.#log(this.#lastError)
      throw failure
    }
  }
}
