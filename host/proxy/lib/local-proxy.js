/**
 * Local mixed proxy: HTTP (CONNECT and absolute-form requests) plus SOCKS5.
 *
 * Every accepted connection is tunneled through the configured Shadowsocks
 * node, so a client only has to point at `127.0.0.1:<port>`. Destination host
 * names travel inside the tunnel, which keeps DNS on the node's side.
 * @module @local/ss-proxy/local-proxy
 */
import net from 'node:net'
import { openTunnel } from './shadowsocks.js'

/** Reply code for a SOCKS5 "connection refused". */
const SOCKS_REFUSED = 0x05
/** Reply code for a SOCKS5 "command not supported". */
const SOCKS_COMMAND_UNSUPPORTED = 0x07

/**
 * Read exactly `n` bytes or until a delimiter from one socket, without losing
 * the bytes a later consumer (pipe) must see.
 */
class SocketReader {
  #socket
  #buffer = Buffer.alloc(0)
  #waiter = null
  #closed = false
  #failure = null

  /** @param socket - the client socket. */
  constructor(socket) {
    this.#socket = socket
    this.onData = (chunk) => {
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
      this.#pump()
    }
    this.onError = (error) => {
      this.#failure = error
      this.#closed = true
      this.#pump()
    }
    this.onClose = () => {
      this.#closed = true
      this.#pump()
    }
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  /** Deliver buffered bytes to a waiting read. */
  #pump() {
    const waiter = this.#waiter
    if (waiter === null) return
    if (this.#failure !== null) {
      this.#waiter = null
      waiter.reject(this.#failure)
      return
    }
    if (waiter.n < 0) {
      // A delimiter wait wakes once more bytes arrive, then re-scans.
      if (this.#buffer.length === waiter.mark) return
      this.#waiter = null
      waiter.resolve()
      return
    }
    if (this.#buffer.length >= waiter.n) {
      this.#waiter = null
      const value = this.#buffer.subarray(0, waiter.n)
      this.#buffer = this.#buffer.subarray(waiter.n)
      waiter.resolve(value)
      return
    }
    if (this.#closed) {
      this.#waiter = null
      waiter.reject(new Error('client closed the connection'))
    }
  }

  /** Wait for exactly `n` bytes. */
  read(n) {
    return new Promise((resolve, reject) => {
      this.#waiter = { n, resolve, reject }
      this.#pump()
    })
  }

  /** Resolve on the next chunk, or reject once the socket ends. */
  #waitForData() {
    return new Promise((resolve, reject) => {
      this.#waiter = { n: -1, mark: this.#buffer.length, resolve, reject }
      this.#pump()
    })
  }

  /** Wait for a delimiter and return the bytes through it. */
  async readUntil(delimiter) {
    for (;;) {
      const index = this.#buffer.indexOf(delimiter)
      if (index !== -1) {
        const end = index + delimiter.length
        const value = this.#buffer.subarray(0, end)
        this.#buffer = this.#buffer.subarray(end)
        return value
      }
      if (this.#closed) throw this.#failure ?? new Error('client closed the connection')
      await this.#waitForData()
    }
  }

  /** Put bytes back in front of the buffer. */
  unshift(chunk) {
    if (chunk.length > 0) this.#buffer = Buffer.concat([chunk, this.#buffer])
  }

  /** Stop reading and hand the remaining bytes to a pipe. */
  release() {
    this.#socket.off('data', this.onData)
    this.#socket.off('error', this.onError)
    this.#socket.off('close', this.onClose)
    const rest = this.#buffer
    this.#buffer = Buffer.alloc(0)
    return rest
  }
}

/** Split `host:port` with IPv6 bracket support. */
export function splitHostPort(authority, fallbackPort) {
  const text = String(authority ?? '').trim()
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end === -1) throw new Error(`invalid authority "${text}"`)
    const host = text.slice(1, end)
    const rest = text.slice(end + 1)
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : fallbackPort
    return { host, port: Number(port) }
  }
  const index = text.lastIndexOf(':')
  if (index === -1) return { host: text, port: Number(fallbackPort) }
  return { host: text.slice(0, index), port: Number(text.slice(index + 1)) }
}

/** Whether a port is a usable destination port. */
function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535
}

/**
 * The local proxy process-facing server.
 */
export class LocalProxy {
  #server = null
  #sockets = new Set()
  #stats = { active: 0, total: 0, bytesUp: 0, bytesDown: 0, failures: 0 }
  #resolveNode
  #log

  /**
   * @param options.resolveNode - returns the current Shadowsocks node, or throws when not configured.
   * @param options.log - optional diagnostic sink.
   */
  constructor({ resolveNode, log = () => {} }) {
    this.#resolveNode = resolveNode
    this.#log = log
  }

  /** Current connection counters. */
  stats() {
    return { ...this.#stats }
  }

  /** The bound port, or `null` before {@link listen}. */
  get port() {
    const address = this.#server?.address()
    return typeof address === 'object' && address !== null ? address.port : null
  }

  /**
   * Listen on the loopback interface.
   * @param port - the port, or 0 for an OS-assigned one.
   * @returns the bound port.
   */
  async listen(port) {
    if (this.#server !== null) return this.port
    const server = net.createServer((socket) => this.#accept(socket))
    server.on('error', (error) => this.#log(`proxy server error: ${error.message}`))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.#server = server
    return this.port
  }

  /** Stop listening and destroy every live tunnel. */
  async close() {
    const server = this.#server
    this.#server = null
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    if (server === null) return
    await new Promise((resolve) => server.close(() => resolve()))
  }

  /** Dispatch one client connection by its first byte. */
  #accept(socket) {
    this.#sockets.add(socket)
    this.#stats.active += 1
    this.#stats.total += 1
    socket.on('close', () => {
      this.#sockets.delete(socket)
      this.#stats.active = Math.max(0, this.#stats.active - 1)
    })
    socket.on('error', () => socket.destroy())
    socket.setNoDelay(true)
    const reader = new SocketReader(socket)
    reader
      .read(1)
      .then((first) => {
        reader.unshift(first)
        return first[0] === 0x05 ? this.#socks(socket, reader) : this.#http(socket, reader)
      })
      .catch((error) => {
        this.#stats.failures += 1
        this.#log(`client handshake failed: ${error.message}`)
        socket.destroy()
      })
  }

  /** Handle one absolute-form or CONNECT HTTP request. */
  async #http(socket, reader) {
    try {
      await this.#httpRequest(socket, reader)
    } catch (error) {
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      throw error
    }
  }

  /** Parse and relay one HTTP proxy request. */
  async #httpRequest(socket, reader) {
    const head = await reader.readUntil(Buffer.from('\r\n\r\n'))
    const text = head.toString('latin1')
    const lines = text.split('\r\n')
    const [method, target, version = 'HTTP/1.1'] = (lines[0] ?? '').split(' ')
    const headers = lines.slice(1).filter((line) => line.length > 0)
    const node = this.#resolveNode()

    if (String(method).toUpperCase() === 'CONNECT') {
      const { host, port } = splitHostPort(target, 443)
      if (!validPort(port)) throw new Error(`invalid CONNECT target "${target}"`)
      const tunnel = await openTunnel(node, { host, port })
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      this.#relay(socket, reader, tunnel)
      return
    }

    let url
    try {
      url = new URL(target)
    } catch {
      throw new Error(`unsupported proxy request target "${target}"`)
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    const tunnel = await openTunnel(node, { host: url.hostname, port })
    const forwarded = [`${method} ${url.pathname}${url.search} ${version}`, ...headers.filter((line) => !/^proxy-connection\s*:/i.test(line)), '', '']
    tunnel.write(Buffer.from(forwarded.join('\r\n'), 'latin1'))
    this.#relay(socket, reader, tunnel)
  }

  /** Handle one SOCKS5 CONNECT request. */
  async #socks(socket, reader) {
    const [version, methodCount] = await reader.read(2)
    if (version !== 0x05) throw new Error('not a SOCKS5 handshake')
    const methods = await reader.read(methodCount)
    if (!methods.includes(0x00)) throw new Error('client requires SOCKS authentication')
    socket.write(Buffer.from([0x05, 0x00]))

    const [requestVersion, command, , addressType] = await reader.read(4)
    if (requestVersion !== 0x05) throw new Error('not a SOCKS5 request')
    if (command !== 0x01) {
      socket.write(Buffer.from([0x05, SOCKS_COMMAND_UNSUPPORTED, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      socket.end()
      return
    }
    let host
    if (addressType === 0x01) {
      const bytes = await reader.read(4)
      host = [...bytes].join('.')
    } else if (addressType === 0x03) {
      const [length] = await reader.read(1)
      host = (await reader.read(length)).toString('utf8')
    } else if (addressType === 0x04) {
      const bytes = await reader.read(16)
      const groups = []
      for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16))
      host = groups.join(':')
    } else {
      socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      socket.end()
      return
    }
    const port = (await reader.read(2)).readUInt16BE(0)
    if (!validPort(port)) throw new Error('invalid SOCKS5 destination port')

    const node = this.#resolveNode()
    let tunnel
    try {
      tunnel = await openTunnel(node, { host, port })
    } catch (error) {
      this.#stats.failures += 1
      this.#log(`SOCKS5 connect ${host}:${port} failed: ${error.message}`)
      socket.write(Buffer.from([0x05, SOCKS_REFUSED, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      socket.end()
      return
    }
    socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
    this.#relay(socket, reader, tunnel)
  }

  /** Pipe the client and the tunnel together, accounting for bytes. */
  #relay(socket, reader, tunnel) {
    const rest = reader.release()
    if (rest.length > 0) tunnel.write(rest)
    socket.on('data', (chunk) => {
      this.#stats.bytesUp += chunk.length
    })
    tunnel.on('data', (chunk) => {
      this.#stats.bytesDown += chunk.length
    })
    socket.pipe(tunnel)
    tunnel.pipe(socket)
    socket.on('error', () => tunnel.destroy())
    tunnel.on('error', (error) => {
      this.#stats.failures += 1
      this.#log(`tunnel failed: ${error.message}`)
      socket.destroy()
    })
    tunnel.on('close', () => socket.destroy())
    socket.on('close', () => tunnel.destroy())
    socket.resume()
  }
}
