/**
 * Shadowsocks AEAD client transport (SIP004, amended by SIP007).
 *
 * A tunnel is a plain TCP connection to the Shadowsocks server whose bytes are
 * framed as AEAD records: a random salt, then any number of
 * `[encrypted length][length tag][encrypted payload][payload tag]` chunks. The
 * first payload carries the target address header, so destination DNS happens
 * on the server side.
 *
 * Only the AEAD ciphers recommended by the project are implemented:
 * `aes-128-gcm`, `aes-256-gcm`, and `chacha20-ietf-poly1305`.
 * @module @local/ss-proxy/shadowsocks
 */
import crypto from 'node:crypto'
import net from 'node:net'
import { Duplex } from 'node:stream'

/** Supported ciphers and the Node names they map to. */
export const CIPHERS = {
  'aes-128-gcm': { keyLen: 16, saltLen: 16, cipher: 'aes-128-gcm' },
  'aes-256-gcm': { keyLen: 32, saltLen: 32, cipher: 'aes-256-gcm' },
  'chacha20-ietf-poly1305': { keyLen: 32, saltLen: 32, cipher: 'chacha20-poly1305' },
}

/** Method names accepted by {@link cipherFor}. */
export const METHOD_NAMES = Object.keys(CIPHERS)

/** Largest plaintext payload one chunk may carry. */
const MAX_PAYLOAD = 0x3fff

/** AEAD authentication tag length shared by every supported cipher. */
const TAG_LENGTH = 16

/**
 * Mark an error as caused by the node itself (a failed AEAD check or a
 * rejected handshake) rather than by one destination.
 *
 * The two are indistinguishable to the caller of a stream, but they mean
 * different things to the route: every destination fails when the node cannot
 * authenticate this client, while a single refused destination says nothing
 * about the node.
 */
export function markNodeFailure(error) {
  const failure = error instanceof Error ? error : new Error(String(error))
  failure.nodeFailure = true
  return failure
}

/** Whether an error implicates the node instead of one destination. */
export function isNodeFailure(error) {
  return error?.nodeFailure === true
}

/**
 * Resolve a method name to its cipher parameters.
 * @param method - the Shadowsocks method name.
 * @returns the cipher parameters.
 */
export function cipherFor(method) {
  const spec = CIPHERS[String(method ?? '').trim().toLowerCase()]
  if (spec === undefined) {
    throw new Error(`unsupported method "${method}" (supported: ${METHOD_NAMES.join(', ')})`)
  }
  return spec
}

/**
 * OpenSSL's EVP_BytesToKey with MD5, as Shadowsocks defines the master key.
 * @param password - the shared password.
 * @param keyLen - the cipher key length.
 * @returns the master key.
 */
export function deriveMasterKey(password, keyLen) {
  const secret = Buffer.from(String(password), 'utf8')
  const blocks = []
  let previous = Buffer.alloc(0)
  let total = 0
  while (total < keyLen) {
    previous = crypto.createHash('md5').update(previous).update(secret).digest()
    blocks.push(previous)
    total += previous.length
  }
  return Buffer.concat(blocks).subarray(0, keyLen)
}

/**
 * HKDF-SHA1 with the shadowsocks info string.
 * @param masterKey - the derived master key.
 * @param salt - the per-connection salt.
 * @param keyLen - the subkey length.
 * @returns the per-connection subkey.
 */
export function deriveSubkey(masterKey, salt, keyLen) {
  return Buffer.from(crypto.hkdfSync('sha1', masterKey, salt, Buffer.from('ss-subkey'), keyLen))
}

/** A 12-byte little-endian AEAD nonce counter. */
class NonceCounter {
  #bytes = Buffer.alloc(12)

  /** Take the current nonce and advance the counter. */
  take() {
    const nonce = Buffer.from(this.#bytes)
    for (let index = 0; index < this.#bytes.length; index += 1) {
      this.#bytes[index] = (this.#bytes[index] + 1) & 0xff
      if (this.#bytes[index] !== 0) break
    }
    return nonce
  }
}

/** Encrypt one record: ciphertext followed by its authentication tag. */
function seal(cipher, key, nonce, plaintext) {
  const encoder = crypto.createCipheriv(cipher, key, nonce, { authTagLength: TAG_LENGTH })
  const body = Buffer.concat([encoder.update(plaintext), encoder.final()])
  return Buffer.concat([body, encoder.getAuthTag()])
}

/** Decrypt one record; throws when the tag does not authenticate. */
function open(cipher, key, nonce, record) {
  const body = record.subarray(0, record.length - TAG_LENGTH)
  const tag = record.subarray(record.length - TAG_LENGTH)
  const decoder = crypto.createDecipheriv(cipher, key, nonce, { authTagLength: TAG_LENGTH })
  decoder.setAuthTag(tag)
  return Buffer.concat([decoder.update(body), decoder.final()])
}

/**
 * Encode a SOCKS-style destination address header.
 * @param host - destination host name or IP literal.
 * @param port - destination port.
 * @returns the address header.
 */
export function addressHeader(host, port) {
  const value = String(host)
  let address
  if (net.isIPv4(value)) {
    address = Buffer.from([0x01, ...value.split('.').map((part) => Number(part))])
  } else if (net.isIPv6(value)) {
    address = Buffer.concat([Buffer.from([0x04]), ipv6Bytes(value)])
  } else {
    const name = Buffer.from(value, 'utf8')
    if (name.length === 0 || name.length > 255) throw new Error(`invalid destination host "${value}"`)
    address = Buffer.concat([Buffer.from([0x03, name.length]), name])
  }
  const portBytes = Buffer.alloc(2)
  portBytes.writeUInt16BE(Number(port))
  return Buffer.concat([address, portBytes])
}

/** Expand an IPv6 literal into its 16 bytes. */
function ipv6Bytes(value) {
  let text = value
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  const [head, tail = ''] = text.split('::')
  const left = head.length === 0 ? [] : head.split(':')
  const right = tail.length === 0 ? [] : tail.split(':')
  // A trailing dotted IPv4 tail occupies the last two groups.
  const expand = (groups) => {
    const out = []
    for (const group of groups) {
      if (group.includes('.')) {
        const parts = group.split('.').map(Number)
        out.push((parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3])
      } else if (group.length > 0) {
        out.push(Number.parseInt(group, 16))
      }
    }
    return out
  }
  const leftWords = expand(left)
  const rightWords = expand(right)
  const missing = 8 - leftWords.length - rightWords.length
  const words = [...leftWords, ...new Array(Math.max(missing, 0)).fill(0), ...rightWords]
  const bytes = Buffer.alloc(16)
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2))
  return bytes
}

/**
 * One Shadowsocks stream: encrypts writes toward the server and decrypts
 * reads from it.
 */
export class ShadowsocksStream extends Duplex {
  #socket
  #spec
  #masterKey
  #encKey
  #decKey = null
  #encNonce = new NonceCounter()
  #decNonce = new NonceCounter()
  #decBuffer = Buffer.alloc(0)
  #pendingLength = -1

  /**
   * @param options.socket - the connected TCP socket to the server.
   * @param options.method - the Shadowsocks method.
   * @param options.password - the shared password.
   * @param options.host - destination host.
   * @param options.port - destination port.
   */
  constructor({ socket, method, password, host, port }) {
    super()
    this.#socket = socket
    this.#spec = cipherFor(method)
    this.#masterKey = deriveMasterKey(password, this.#spec.keyLen)
    const salt = crypto.randomBytes(this.#spec.saltLen)
    this.#encKey = deriveSubkey(this.#masterKey, salt, this.#spec.keyLen)
    socket.on('data', (chunk) => this.#receive(chunk))
    socket.on('error', (error) => this.destroy(error))
    socket.on('close', () => this.push(null))
    socket.write(salt)
    this.#writeRecords(addressHeader(host, port))
  }

  /** Encrypt and write one plaintext buffer as one or more records. */
  #writeRecords(buffer) {
    let offset = 0
    while (offset < buffer.length || offset === 0) {
      const end = Math.min(offset + MAX_PAYLOAD, buffer.length)
      const payload = buffer.subarray(offset, end)
      const length = Buffer.alloc(2)
      length.writeUInt16BE(payload.length)
      const first = seal(this.#spec.cipher, this.#encKey, this.#encNonce.take(), length)
      const second = seal(this.#spec.cipher, this.#encKey, this.#encNonce.take(), payload)
      this.#socket.write(Buffer.concat([first, second]))
      if (end >= buffer.length) break
      offset = end
    }
  }

  /** Consume server bytes, emitting decrypted payloads. */
  #receive(chunk) {
    this.#decBuffer = this.#decBuffer.length === 0 ? chunk : Buffer.concat([this.#decBuffer, chunk])
    try {
      if (this.#decKey === null) {
        if (this.#decBuffer.length < this.#spec.saltLen) return
        const salt = this.#decBuffer.subarray(0, this.#spec.saltLen)
        this.#decBuffer = this.#decBuffer.subarray(this.#spec.saltLen)
        this.#decKey = deriveSubkey(this.#masterKey, salt, this.#spec.keyLen)
      }
      for (;;) {
        if (this.#pendingLength < 0) {
          if (this.#decBuffer.length < 2 + TAG_LENGTH) return
          const record = this.#decBuffer.subarray(0, 2 + TAG_LENGTH)
          this.#decBuffer = this.#decBuffer.subarray(2 + TAG_LENGTH)
          const plain = open(this.#spec.cipher, this.#decKey, this.#decNonce.take(), record)
          this.#pendingLength = plain.readUInt16BE(0)
          if (this.#pendingLength > MAX_PAYLOAD) {
            throw new Error('shadowsocks: record exceeds the maximum payload')
          }
        }
        if (this.#decBuffer.length < this.#pendingLength + TAG_LENGTH) return
        const record = this.#decBuffer.subarray(0, this.#pendingLength + TAG_LENGTH)
        this.#decBuffer = this.#decBuffer.subarray(this.#pendingLength + TAG_LENGTH)
        const payload = open(this.#spec.cipher, this.#decKey, this.#decNonce.take(), record)
        this.#pendingLength = -1
        if (payload.length > 0) this.push(payload)
      }
    } catch (error) {
      // Only the AEAD layer knows the node rejected this client; a socket error
      // stays an ordinary connection failure and must not take the route down.
      this.destroy(markNodeFailure(error))
    }
  }

  /** Duplex write: encrypt toward the server. */
  _write(chunk, _encoding, callback) {
    try {
      this.#writeRecords(chunk)
      callback()
    } catch (error) {
      callback(error)
    }
  }

  /** Duplex read: data arrives through {@link #receive}. */
  _read() {}

  /** Duplex final: half-close the TCP connection. */
  _final(callback) {
    this.#socket.end()
    callback()
  }

  /** Duplex destroy: tear the TCP connection down. */
  _destroy(error, callback) {
    this.#socket.destroy()
    callback(error)
  }
}

/**
 * Connect one Shadowsocks tunnel to a destination.
 * @param node - `{ server, port, method, password }`.
 * @param target - `{ host, port }`.
 * @param options - optional connect timeout in milliseconds.
 * @returns the connected tunnel stream.
 */
export async function openTunnel(node, target, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 12000
  if (typeof node.server !== 'string' || node.server.length === 0) throw new Error('Shadowsocks server is not configured')
  if (!Number.isInteger(Number(node.port)) || Number(node.port) <= 0 || Number(node.port) > 65535) {
    throw new Error('Shadowsocks server port is invalid')
  }
  if (typeof node.password !== 'string' || node.password.length === 0) throw new Error('Shadowsocks password is not configured')

  const socket = net.connect({ host: node.server, port: Number(node.port) })
  socket.setNoDelay(true)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timed out connecting to ${node.server}:${node.port}`))
    }, timeoutMs)
    const settle = (error) => {
      clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('error', onError)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onConnect = () => settle(undefined)
    const onError = (error) => settle(error)
    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
  return new ShadowsocksStream({
    socket,
    method: node.method,
    password: node.password,
    host: target.host,
    port: target.port,
  })
}
