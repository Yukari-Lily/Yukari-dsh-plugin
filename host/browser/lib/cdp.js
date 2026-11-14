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
  #waiters = new Set()
  #closeListeners = new Set()
  #closed = false

  /**
   * @param socket - an open WebSocket.
   */
  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => this.#receive(event.data))
    socket.addEventListener('close', () => this.#shutdown('浏览器连接已断开'))
    socket.addEventListener('error', () => this.#shutdown('浏览器连接出错'))
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
    if (this.#closed) return Promise.reject(new CdpError('浏览器连接已关闭'))
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
   * Notify the owner when the connection dies, so it can drop stale state.
   * @param listener - receives the failure text.
   * @returns an unsubscribe function.
   */
  onClose(listener) {
    if (this.#closed) {
      listener('浏览器连接已关闭')
      return () => {}
    }
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  /**
   * Resolve on the first matching protocol event.
   * @param method - exact event name.
   * @param predicate - extra filter over the event params and session.
   * @param timeoutMs - budget before the wait rejects.
   * @returns the event params.
   */
  once(method, predicate = () => true, timeoutMs = 20000) {
    if (this.#closed) return Promise.reject(new CdpError(`${method}: 浏览器连接已断开`))
    return new Promise((resolve, reject) => {
      const waiter = { method, reject, off: undefined, timer: undefined }
      const off = this.onEvent((name, params, sessionId) => {
        if (name !== method) return
        if (!predicate(params, sessionId)) return
        clearTimeout(waiter.timer)
        this.#waiters.delete(waiter)
        off()
        resolve(params)
      })
      waiter.off = off
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter)
        off()
        reject(new CdpError(`${method} did not arrive within ${timeoutMs}ms`))
      }, timeoutMs)
      this.#waiters.add(waiter)
    })
  }

  /** Close the socket and reject every outstanding command and wait. */
  close() {
    if (this.#closed) return
    this.#shutdown('浏览器连接已关闭')
    try { this.#socket.close() } catch { /* ignore */ }
  }

  /** @param reason - failure text; the connection cannot be reused afterwards. */
  #shutdown(reason) {
    if (this.#closed) return
    this.#closed = true
    this.#failAll(reason)
    for (const listener of [...this.#closeListeners]) {
      try {
        listener(reason)
      } catch {
        // One owner callback must not keep the other listeners from running.
      }
    }
    this.#closeListeners.clear()
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

  /** @param reason - failure text for outstanding commands and event waits. */
  #failAll(reason) {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.reject(new CdpError(`${pending.method}: ${reason}`))
    }
    for (const waiter of [...this.#waiters]) {
      clearTimeout(waiter.timer)
      this.#waiters.delete(waiter)
      waiter.off()
      waiter.reject(new CdpError(`${waiter.method}: ${reason}`))
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
  let child
  try {
    child = spawn(executablePath, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new CdpError(`无法启动浏览器进程 ${executablePath}：${error instanceof Error ? error.message : String(error)}`)
  }
  let log = ''
  let endpoint = ''
  let exited = null
  let startError = null
  // 没有 error 监听时，ENOENT/EACCES 会变成 uncaughtException，宿主的
  // fail-loud 处理器会直接结束整个进程；这里把它降级成一次工具调用失败。
  child.on('error', (error) => { startError = error })
  child.on('exit', (code, signal) => { exited = { code, signal } })
  const onChunk = (chunk) => {
    log += chunk.toString()
    if (log.length > 20000) log = log.slice(-20000)
    if (endpoint === '') {
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(log)
      if (match) endpoint = match[1]
    }
  }
  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)

  const started = Date.now()
  while (endpoint === '' && startError === null && Date.now() - started < timeoutMs) {
    if (exited) {
      throw new CdpError(`browser exited before it became ready (code ${exited.code ?? 'null'}, signal ${exited.signal ?? 'none'}): ${summarize(log)}`)
    }
    await sleep(100)
  }
  if (startError !== null) {
    try { child.kill('SIGKILL') } catch { /* it never started */ }
    throw new CdpError(`无法启动浏览器进程 ${executablePath}：${startError.message}`)
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
