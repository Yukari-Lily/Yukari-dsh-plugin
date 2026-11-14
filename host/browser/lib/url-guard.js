/**
 * Navigation address policy for the controlled browser.
 *
 * A tool argument, a page link, or a redirect can point Chromium at loopback
 * services, private networks, and cloud metadata endpoints. The host has no
 * network boundary of its own, so the browser refuses those addresses before
 * navigation and checks the landing address again after redirects.
 * @module @local/browser-control/url-guard
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u

/**
 * Why a literal IPv4 address is not publicly routable.
 * @param address - dotted quad.
 * @returns a Chinese reason, or null for a public address.
 */
export function privateIpv4Reason(address) {
  const match = IPV4.exec(address)
  if (!match) return null
  const octets = match.slice(1).map(Number)
  if (octets.some((octet) => octet > 255)) return null
  const [first, second] = octets
  if (first === 0) return '未指定地址'
  if (first === 127) return '本机回环地址'
  if (first === 10) return '私有网段地址'
  if (first === 172 && second >= 16 && second <= 31) return '私有网段地址'
  if (first === 192 && second === 168) return '私有网段地址'
  if (first === 169 && second === 254) return '链路本地地址'
  return null
}

/** Expand an IPv6 literal into eight 16-bit groups, or null. */
function expandIpv6(host) {
  if (!host.includes(':') || host.split('::').length > 2) return null
  const [left, right] = host.split('::')
  const expand = (part) => {
    if (part === '') return []
    const groups = []
    for (const piece of part.split(':')) {
      if (piece.includes('.')) {
        const match = IPV4.exec(piece)
        if (!match) return null
        const octets = match.slice(1).map(Number)
        if (octets.some((octet) => octet > 255)) return null
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
      } else if (/^[0-9a-f]{1,4}$/iu.test(piece)) {
        groups.push(Number.parseInt(piece, 16))
      } else {
        return null
      }
    }
    return groups
  }
  const head = expand(left)
  const tail = expand(right ?? '')
  if (head === null || tail === null) return null
  if (right === undefined) return head.length === 8 ? head : null
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  return [...head, ...Array(missing).fill(0), ...tail]
}

/**
 * Why a literal IPv6 address is not publicly routable.
 * @param address - IPv6 literal without brackets.
 * @returns a Chinese reason, or null for a public address.
 */
export function privateIpv6Reason(address) {
  const groups = expandIpv6(address)
  if (groups === null) return null
  if (groups.every((group) => group === 0)) return '未指定地址'
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return '本机回环地址'
  // IPv4-mapped addresses are the usual way a private IPv4 slips past a
  // family check, so unwrap them and apply the IPv4 ranges.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
    return privateIpv4Reason(mapped)
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return '私有网段地址'
  if ((groups[0] & 0xffc0) === 0xfe80) return '链路本地地址'
  return null
}

/**
 * Why a host name points inside the machine or the local network.
 * @param hostname - WHATWG URL hostname, brackets included for IPv6.
 * @returns a Chinese reason, or null when the host is public.
 */
export function privateHostReason(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase()
  if (host === '') return null
  if (host === 'localhost' || host.endsWith('.localhost')) return '本机回环地址'
  if (host.includes(':')) return privateIpv6Reason(host)
  return privateIpv4Reason(host)
}

/**
 * Decide whether a navigation may proceed.
 * @param url - absolute URL, string or URL.
 * @param options - `allowLocalUrls` opts into local content and private hosts.
 * @returns a Chinese refusal reason, or null when the URL is allowed.
 */
export function blockedNavigationReason(url, options = {}) {
  let parsed
  try {
    parsed = url instanceof URL ? url : new URL(String(url))
  } catch {
    return `无法解析导航地址 ${String(url)}`
  }
  if (!/^(https?|file|data|about):$/u.test(parsed.protocol)) {
    return `不支持的 URL 协议 ${parsed.protocol}`
  }
  if (parsed.protocol === 'about:') return null
  if (options.allowLocalUrls === true) return null
  if (parsed.protocol === 'file:' || parsed.protocol === 'data:') {
    return `${parsed.protocol} URL 默认被禁用；确需本地内容时将 browser allowLocalUrls 设为 true`
  }
  const reason = privateHostReason(parsed.hostname)
  if (reason === null) return null
  return `默认禁止访问${reason}（${parsed.host}）；确需访问时将 browser allowLocalUrls 设为 true`
}
