/**
 * Parse a Shadowsocks share link (SIP002).
 * @module @local/ss-proxy/ss-uri
 */

/** Decode a base64 or base64url string. */
function decodeBase64(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, 'base64').toString('utf8')
}

/** Split a host:port authority, accepting bracketed IPv6 literals. */
function parseAuthority(authority) {
  const text = authority.trim()
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end === -1) throw new Error('invalid host in ss:// link')
    const host = text.slice(1, end)
    const rest = text.slice(end + 1)
    if (!rest.startsWith(':')) throw new Error('missing port in ss:// link')
    return { host, port: Number(rest.slice(1)) }
  }
  const index = text.lastIndexOf(':')
  if (index === -1) throw new Error('missing port in ss:// link')
  return { host: text.slice(0, index), port: Number(text.slice(index + 1)) }
}

/**
 * Parse an `ss://` link into node fields.
 * @param input - the share link.
 * @returns `{ server, port, method, password, tag }`.
 */
export function parseShadowsocksUri(input) {
  let text = String(input ?? '').trim()
  if (!text.toLowerCase().startsWith('ss://')) throw new Error('expected a link starting with ss://')
  text = text.slice(5)
  let tag = ''
  const hash = text.indexOf('#')
  if (hash !== -1) {
    tag = decodeURIComponent(text.slice(hash + 1))
    text = text.slice(0, hash)
  }
  let query = ''
  const question = text.indexOf('?')
  if (question !== -1) {
    query = text.slice(question + 1)
    text = text.slice(0, question)
  }
  const plugin = new URLSearchParams(query).get('plugin')
  if (plugin !== null && plugin.length > 0) {
    throw new Error(`SIP003 plugin "${plugin.split(';')[0]}" is not supported; use a plain Shadowsocks node`)
  }

  const at = text.lastIndexOf('@')
  let credentials
  let authority
  if (at === -1) {
    // Legacy form: the whole payload is base64 of method:password@host:port.
    const decoded = decodeBase64(text)
    const inner = decoded.lastIndexOf('@')
    if (inner === -1) throw new Error('invalid ss:// link')
    credentials = decoded.slice(0, inner)
    authority = decoded.slice(inner + 1)
  } else {
    const userinfo = text.slice(0, at)
    authority = text.slice(at + 1)
    credentials = userinfo.includes(':') ? decodeURIComponent(userinfo) : decodeBase64(userinfo)
  }
  const separator = credentials.indexOf(':')
  if (separator === -1) throw new Error('ss:// link carries no method:password')
  const method = credentials.slice(0, separator)
  const password = credentials.slice(separator + 1)
  if (method.length === 0 || password.length === 0) throw new Error('ss:// link carries no method:password')
  const { host, port } = parseAuthority(authority)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('invalid port in ss:// link')
  return { server: host, port, method, password, tag }
}

/** Split one or more top-level JSON objects out of pasted text. */
function jsonObjects(text) {
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : [value]
  } catch {
    // Fall through to a balanced-brace scan for several pasted objects.
  }
  const objects = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0 && start !== -1) {
        try {
          objects.push(JSON.parse(text.slice(start, index + 1)))
        } catch {
          // Ignore one malformed object and keep scanning.
        }
        start = -1
      }
    }
  }
  return objects
}

/** Map one Clash / subscription entry to node fields, or null when it is not an SS node. */
function nodeFromObject(object, forbiddenMethods) {
  if (object === null || typeof object !== 'object') return null
  const type = typeof object.type === 'string' ? object.type.trim().toLowerCase() : ''
  if (type !== '' && type !== 'ss') return null
  const server = typeof object.server === 'string' ? object.server.trim() : ''
  const port = Number(object.port)
  const method = String(object.cipher ?? object.method ?? '').trim().toLowerCase()
  const password = typeof object.password === 'string' ? object.password : ''
  if (typeof object.plugin === 'string' && object.plugin.trim().length > 0) return null
  if (server.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  if (method.length === 0 || password.length === 0) return null
  if (forbiddenMethods !== undefined && !forbiddenMethods.includes(method)) return null
  return { server, port, method, password, name: typeof object.name === 'string' ? object.name : '' }
}

/**
 * Parse pasted input into node fields.
 *
 * Accepts an `ss://` share link (SIP002 or legacy) and the JSON shape used by
 * Clash and Shadowsocks subscriptions: one object, a JSON array, or several
 * objects pasted on separate lines.
 *
 * @param input - pasted text.
 * @param methods - accepted method names.
 * @returns the first usable node.
 */
export function parseNodeInput(input, methods) {
  const text = String(input ?? '').trim()
  if (text.length === 0) throw new Error('paste an ss:// link or a Shadowsocks JSON config')
  if (text.toLowerCase().startsWith('ss://')) {
    const node = parseShadowsocksUri(text)
    if (methods !== undefined && !methods.includes(node.method.toLowerCase())) {
      throw new Error(`unsupported method "${node.method}" (use ${methods.join(', ')})`)
    }
    return { ...node, method: node.method.toLowerCase(), name: node.name ?? node.tag ?? '' }
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    const objects = jsonObjects(text)
    if (objects.length === 0) throw new Error('the pasted JSON could not be read')
    for (const object of objects) {
      const node = nodeFromObject(object, methods)
      if (node !== null) return node
    }
    throw new Error('no usable Shadowsocks node in the pasted JSON (need type "ss", server, port, cipher, password)')
  }
  throw new Error('expected an ss:// link or a Shadowsocks JSON config')
}
