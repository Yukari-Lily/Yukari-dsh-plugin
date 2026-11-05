/**
 * A very small Chrome DevTools Protocol client.
 *
 * The Harness runs on Node's built-in `fetch`/`WebSocket`, so browser control
 * needs no npm dependency: connect to the browser endpoint Chrome prints on
 * stderr, attach to a page target, and speak JSON over that one socket.
 * @module @local/browser-control/cdp
 */

/** Raised when the browser or a protocol call refuses a request. */
export class CdpError extends Error {
  /**
   * @param message - human readable failure.
   * @param code - optional CDP error code.
   */
  constructor(message, code) {
    super(message)
    this.name = 'CdpError'
    this.code = code
  }
}

/** Delay helper. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One protocol connection: either the browser endpoint or, with a
 * `sessionId`, a flattened page target.
 */
export class CdpClient {
  #socket
  #nextId = 1
  #pending = new Map()
  #events = new Set()
  #closed = false

  /**
   * @param socket - an open WebSocket.
   */
  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => this.#receive(event.data))
    socket.addEventListener('close', () => this.#failAll('browser connection closed'))
    socket.addEventListener('error', () => this.#failAll('browser connection error'))
  }

  /**
   * Open a protocol connection.
   * @param url - `ws://` DevTools endpoint.
   * @param timeoutMs - connection budget.
   * @returns the connected client.
   */
  static async connect(url, timeoutMs = 20000) {
    if (typeof globalThis.WebSocket !== 'function') {
      throw new CdpError('this Node.js runtime has no global WebSocket (Node 22 or newer is required)')
    }
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { socket.close() } catch { /* ignore */ }
        reject(new CdpError(`timed out after ${timeoutMs}ms connecting to ${url}`))
      }, timeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new CdpError(`cannot connect to the browser endpoint ${url}`))
      }, { once: true })
    })
    return new CdpClient(socket)
  }

  /** Whether the socket is still usable. */
  get open() {
    return !this.#closed
  }

  /**
   * Send one protocol command.
   * @param method - CDP method name.
   * @param params - method parameters.
   * @param sessionId - flattened page session, when addressing a page.
   * @returns the method result.
   */
  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new CdpError('browser connection is closed'))
    const id = this.#nextId++
    const message = { id, method, params }
    if (sessionId !== undefined) message.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CdpError(`${method} timed out`))
      }, 60000)
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        this.#socket.send(JSON.stringify(message))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new CdpError(`${method} could not be sent: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  /**
   * Subscribe to protocol events.
   * @param listener - receives `(method, params, sessionId)`.
   * @returns an unsubscribe function.
   */
  onEvent(listener) {
    this.#events.add(listener)
    return () => this.#events.delete(listener)
  }

  /**
   * Resolve on the first matching protocol event.
   * @param method - exact event name.
   * @param predicate - extra filter over the event params and session.
   * @param timeoutMs - budget before the wait rejects.
   * @returns the event params.
   */
  once(method, predicate = () => true, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new CdpError(`${method} did not arrive within ${timeoutMs}ms`))
      }, timeoutMs)
      const off = this.onEvent((name, params, sessionId) => {
        if (name !== method) return
        if (!predicate(params, sessionId)) return
        clearTimeout(timer)
        off()
        resolve(params)
      })
    })
  }

  /** Close the socket and reject every outstanding command. */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.#failAll('browser connection closed')
    try { this.#socket.close() } catch { /* ignore */ }
  }

  /** @param raw - JSON frame from the socket. */
  #receive(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id)
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(new CdpError(`${pending.method}: ${message.error.message ?? 'protocol error'}`, message.error.code))
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }
    if (message.method) {
      for (const listener of [...this.#events]) {
        try {
          listener(message.method, message.params ?? {}, message.sessionId)
        } catch {
          // A listener fault must not break protocol delivery.
        }
      }
    }
  }

  /** @param reason - failure text for outstanding commands. */
  #failAll(reason) {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.reject(new CdpError(`${pending.method}: ${reason}`))
    }
  }
}

/**
 * Start a Chromium process with the DevTools protocol enabled.
 *
 * @param options - executable, arguments, environment, and start budget.
 * @returns the process handle, its browser endpoint, and a stop function.
 */
export async function launchChromium(options) {
  const { spawn } = await import('node:child_process')
  const { executablePath, args = [], env = {}, timeoutMs = 30000 } = options
  const child = spawn(executablePath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  let endpoint = ''
  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })
  const onChunk = (chunk) => {
    log += chunk.toString()
    if (log.length > 20000) log = log.slice(-20000)
    if (endpoint === '') {
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(log)
      if (match) endpoint = match[1]
    }
  }
  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)

  const started = Date.now()
  while (endpoint === '' && Date.now() - started < timeoutMs) {
    if (exited) {
      throw new CdpError(`browser exited before it became ready (code ${exited.code ?? 'null'}, signal ${exited.signal ?? 'none'}): ${summarize(log)}`)
    }
    await sleep(100)
  }
  if (endpoint === '') {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    throw new CdpError(`browser did not expose a DevTools endpoint within ${timeoutMs}ms: ${summarize(log)}`)
  }
  return {
    process: child,
    endpoint,
    log: () => log,
    stop: async () => {
      if (exited) return
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      for (let i = 0; i < 30 && !exited; i++) await sleep(100)
      if (!exited) {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }
    },
  }
}

/** Keep the last interesting browser log lines for a failure message. */
function summarize(log) {
  const lines = log
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/dbus|Fontconfig|zygote_host|vaapi|InitializeSandbox|DevTools listening/u.test(line))
  return lines.slice(-3).join(' | ') || 'no diagnostics'
}
