/**
 * Parse Shadowsocks share links (SIP002) and the common ways nodes are pasted:
 * several links, a base64 subscription, Clash YAML, or JSON.
 * @module @local/ss-proxy/ss-uri
 */

/** Any `scheme://` share link start. */
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i

/** Schemes that are ordinary URLs rather than proxy nodes; never counted as skipped. */
const NON_NODE_SCHEMES = new Set(['http', 'https', 'ftp', 'file'])

/** Decode a base64 or base64url string. */
function decodeBase64(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, 'base64').toString('utf8')
}

/** Percent-decode, keeping the raw text when it is not valid encoding. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
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
    tag = safeDecode(text.slice(hash + 1)).trim()
    text = text.slice(0, hash)
  }
  let query = ''
  const question = text.indexOf('?')
  if (question !== -1) {
    query = text.slice(question + 1)
    text = text.slice(0, question)
  }
  // SIP002 allows `host:port/?plugin=…`; the slash is not part of the port.
  text = text.replace(/\/+$/, '')
  const plugin = new URLSearchParams(query).get('plugin')
  if (plugin !== null && plugin.length > 0) {
    throw new Error(`SIP003 plugin "${plugin.split(';')[0]}" is not supported; use a plain Shadowsocks node`)
  }

  const at = text.lastIndexOf('@')
  let credentials
  let authority
  if (at === -1) {
    // Legacy form: the whole payload is base64 of method:password@host:port.
    const decoded = decodeBase64(safeDecode(text))
    const inner = decoded.lastIndexOf('@')
    if (inner === -1) throw new Error('invalid ss:// link')
    credentials = decoded.slice(0, inner)
    authority = decoded.slice(inner + 1)
  } else {
    const userinfo = text.slice(0, at)
    authority = text.slice(at + 1)
    const plain = safeDecode(userinfo)
    credentials = plain.includes(':') ? plain : decodeBase64(plain)
  }
  const separator = credentials.indexOf(':')
  if (separator === -1) throw new Error('ss:// link carries no method:password')
  const method = credentials.slice(0, separator)
  const password = credentials.slice(separator + 1)
  if (method.length === 0 || password.length === 0) throw new Error('ss:// link carries no method:password')
  const { host, port } = parseAuthority(authority)
  if (host.length === 0) throw new Error('invalid host in ss:// link')
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

/**
 * Map one Clash / SIP008 / libev entry to node fields.
 * @throws when the entry is not a usable plain Shadowsocks node.
 */
function nodeFromObject(object, methods) {
  if (object === null || typeof object !== 'object') throw new Error('not an object')
  const type = typeof object.type === 'string' ? object.type.trim().toLowerCase() : ''
  if (type !== '' && type !== 'ss' && type !== 'shadowsocks') throw new Error(`type "${type}" is not Shadowsocks`)
  if (typeof object.plugin === 'string' && object.plugin.trim().length > 0) throw new Error(`plugin "${object.plugin.trim()}" is not supported`)
  const server = typeof object.server === 'string' ? object.server.trim() : ''
  const port = Number(object.port ?? object.server_port)
  const method = String(object.cipher ?? object.method ?? '').trim().toLowerCase()
  const password = typeof object.password === 'string' ? object.password : typeof object.password === 'number' ? String(object.password) : ''
  if (server.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('entry needs server and port')
  if (method.length === 0 || password.length === 0) throw new Error('entry needs cipher and password')
  if (methods !== undefined && !methods.includes(method)) throw new Error(`unsupported method "${method}"`)
  const name = [object.name, object.remarks, object.tag].find((value) => typeof value === 'string' && value.trim().length > 0)
  return { server, port, method, password, name: name === undefined ? '' : name.trim() }
}

/** Empty parse result. */
const emptyResult = () => ({ nodes: [], skipped: 0, reason: '' })

/** Count one skipped entry, remembering the first reason for the error message. */
function skip(result, reason) {
  result.skipped += 1
  if (result.reason === '') result.reason = reason
}

/** Add one object entry, or count it as skipped. */
function addObject(result, object, methods) {
  try {
    result.nodes.push(nodeFromObject(object, methods))
  } catch (error) {
    skip(result, error.message)
  }
}

/** Collect every `scheme://` link in text; null when there is none. */
function nodesFromLinks(text, methods) {
  const result = emptyResult()
  let found = false
  for (const line of text.split(/\r?\n/)) {
    // Split only before another link so a raw `#tag with spaces` stays whole.
    for (const token of line.trim().split(/\s+(?=[a-z][a-z0-9+.-]*:\/\/)/i)) {
      const scheme = SCHEME.exec(token)?.[1]?.toLowerCase()
      if (scheme === undefined || NON_NODE_SCHEMES.has(scheme)) continue
      found = true
      if (scheme !== 'ss') {
        skip(result, `${scheme}:// links are not Shadowsocks`)
        continue
      }
      try {
        const link = parseShadowsocksUri(token)
        const method = link.method.toLowerCase()
        if (methods !== undefined && !methods.includes(method)) {
          skip(result, `unsupported method "${link.method}"`)
          continue
        }
        result.nodes.push({ server: link.server, port: link.port, method, password: link.password, name: link.tag })
      } catch (error) {
        skip(result, error.message)
      }
    }
  }
  return found ? result : null
}

/** Decode a base64 subscription blob into its links; null when the text is not one. */
function nodesFromSubscription(text, methods) {
  const compact = text.replace(/\s+/g, '')
  if (compact.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null
  const decoded = decodeBase64(compact)
  if (!/[a-z][a-z0-9+.-]*:\/\//i.test(decoded)) return null
  return nodesFromLinks(decoded, methods)
}

/** Read JSON: one object, an array, `{ proxies }` / `{ servers }`, or several pasted objects. */
function nodesFromJson(text, methods) {
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  const objects = jsonObjects(text)
  if (objects.length === 0) return null
  const result = emptyResult()
  const visit = (value, depth) => {
    if (depth > 4) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (value !== null && typeof value === 'object') {
      if (Array.isArray(value.proxies)) return visit(value.proxies, depth + 1)
      if (Array.isArray(value.servers)) return visit(value.servers, depth + 1)
    }
    addObject(result, value, methods)
  }
  visit(objects, 0)
  return result
}

/** Whether a quote at `index` opens a quoted scalar (it follows a separator, not a word). */
function opensQuote(text, index) {
  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(text[cursor])) cursor -= 1
  return cursor < 0 || ':,{[-'.includes(text[cursor])
}

/**
 * Scan YAML text outside quotes.
 * @param onCharacter - called with `(character, index, depth)`; return true to stop.
 * @returns the bracket depth at the end.
 */
function scanYaml(text, onCharacter) {
  let quote = ''
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote !== '') {
      if (quote === '"' && character === '\\') index += 1
      else if (quote === "'" && character === "'" && text[index + 1] === "'") index += 1
      else if (character === quote) quote = ''
      continue
    }
    if ((character === '"' || character === "'") && opensQuote(text, index)) {
      quote = character
      continue
    }
    if (onCharacter(character, index, depth) === true) break
    if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
  }
  return depth
}

/** Drop a trailing ` # comment`. */
function stripComment(text) {
  let end = text.length
  scanYaml(text, (character, index) => {
    if (character !== '#' || (index > 0 && !/\s/.test(text[index - 1]))) return false
    end = index
    return true
  })
  return text.slice(0, end)
}

/** Read one YAML scalar: double-quoted, single-quoted, or plain. */
function yamlScalar(raw) {
  const text = raw.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'")
  return text
}

/** Split `key: value`; null when the text holds no mapping separator. */
function splitPair(text) {
  let separator = -1
  scanYaml(text, (character, index, depth) => {
    if (character !== ':' || depth !== 0) return false
    if (index + 1 < text.length && !/\s/.test(text[index + 1])) return false
    separator = index
    return true
  })
  if (separator === -1) return null
  return [yamlScalar(text.slice(0, separator)), text.slice(separator + 1).trim()]
}

/** Read a flow map `{ k: v, … }`; nested values stay as raw text. */
function yamlFlowMap(text) {
  const inner = text.trim().replace(/^\{/, '').replace(/\}$/, '')
  const object = {}
  let start = 0
  const parts = []
  scanYaml(inner, (character, index, depth) => {
    if (character === ',' && depth === 0) {
      parts.push(inner.slice(start, index))
      start = index + 1
    }
    return false
  })
  parts.push(inner.slice(start))
  for (const part of parts) {
    const pair = splitPair(part.trim())
    if (pair !== null && pair[0] !== '') object[pair[0]] = yamlScalar(pair[1])
  }
  return object
}

/** Leading-space count of a line. */
const indentOf = (line) => line.length - line.trimStart().length

/**
 * Read the entries of a Clash `proxies:` list (flow-map and block-style items).
 * Only this shape is understood; anything else ends the list.
 * @returns the entry objects, or null when the text has no such list.
 */
function clashEntries(text) {
  const lines = text.split(/\r?\n/).map((line) => stripComment(line.replace(/\t/g, '  ')).trimEnd())
  let index = lines.findIndex((line) => /^\s*proxies\s*:\s*$/.test(line))
  if (index === -1) {
    // A bare list pasted without its `proxies:` header.
    if (!/^\s*-\s+(\{|["']?name["']?\s*:)/.test(lines.find((line) => line.trim() !== '') ?? '')) return null
  }
  const headerIndent = index === -1 ? -1 : indentOf(lines[index])
  const entries = []
  let listIndent = -1
  let current = null
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === '') continue
    const indent = indentOf(line)
    const dash = trimmed === '-' || trimmed.startsWith('- ')
    if (listIndent === -1) {
      if (!dash || indent < headerIndent) break
      listIndent = indent
    }
    if (indent < listIndent || (indent === listIndent && !dash)) break
    if (indent === listIndent) {
      const rest = trimmed.slice(1).trim()
      current = null
      if (rest.startsWith('{')) {
        let flow = rest
        while (scanYaml(flow, () => false) > 0 && index + 1 < lines.length) {
          index += 1
          flow += ` ${lines[index].trim()}`
        }
        entries.push(yamlFlowMap(flow))
        continue
      }
      current = { object: {}, keyIndent: rest === '' ? -1 : line.indexOf(rest, indent + 1) }
      entries.push(current.object)
      const pair = rest === '' ? null : splitPair(rest)
      if (pair !== null) current.object[pair[0]] = yamlScalar(pair[1])
      continue
    }
    if (current === null) continue
    if (current.keyIndent === -1) current.keyIndent = indent
    // Deeper lines belong to nested blocks such as `plugin-opts:`.
    if (indent !== current.keyIndent) continue
    const pair = splitPair(trimmed)
    if (pair !== null) current.object[pair[0]] = yamlScalar(pair[1])
  }
  return listIndent === -1 ? null : entries
}

/** Read a Clash YAML `proxies:` list; null when the text is not one. */
function nodesFromClash(text, methods) {
  const entries = clashEntries(text)
  if (entries === null) return null
  const result = emptyResult()
  for (const entry of entries) addObject(result, entry, methods)
  return result
}

/**
 * Parse pasted input into every usable node.
 *
 * Accepts, in order of detection: text holding `ss://` links (SIP002 or
 * legacy), a base64 subscription blob of links, JSON (one object, an array,
 * `{ proxies: [...] }`, or several pasted objects), and a Clash YAML
 * `proxies:` list. Other link schemes, non-ss entries, SIP003 plugins, and
 * unsupported ciphers are skipped and counted.
 *
 * @param input - pasted text.
 * @param methods - accepted method names.
 * @returns `{ nodes: [{ server, port, method, password, name }], skipped }`.
 * @throws when nothing usable was found.
 */
export function parseNodesInput(input, methods) {
  const text = String(input ?? '').trim()
  if (text.length === 0) throw new Error('paste ss:// links, a subscription, Clash YAML, or a Shadowsocks JSON config')
  const detectors = [
    () => (/ss:\/\//i.test(text) ? nodesFromLinks(text, methods) : null),
    () => nodesFromSubscription(text, methods),
    () => nodesFromJson(text, methods),
    () => nodesFromClash(text, methods),
    () => nodesFromLinks(text, methods),
  ]
  let best = null
  for (const detect of detectors) {
    const result = detect()
    if (result === null) continue
    if (result.nodes.length > 0) return { nodes: result.nodes, skipped: result.skipped }
    if (best === null || result.skipped > best.skipped) best = result
  }
  if (best === null) throw new Error('expected ss:// links, a base64 subscription, Clash YAML, or a Shadowsocks JSON config')
  const detail = best.reason === '' ? '' : ` (${best.reason})`
  throw new Error(`no usable Shadowsocks node found; skipped ${best.skipped}${detail}`)
}

/**
 * Parse pasted input into node fields.
 * @param input - pasted text.
 * @param methods - accepted method names.
 * @returns the first usable node.
 */
export function parseNodeInput(input, methods) {
  return parseNodesInput(input, methods).nodes[0]
}
