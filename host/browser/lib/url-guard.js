/**
 * Navigation address policy for the controlled browser.
 *
 * A tool argument, a page link, or a redirect can point Chromium at loopback
 * services, private networks, and cloud metadata endpoints. The host has no
 * network boundary of its own, so the browser refuses those addresses before
 * navigation and checks the landing address again after redirects. 网段名单在
 * `host/shared/net.js`，与出站代理共用。
 * @module @local/browser-control/url-guard
 */
import { privateHostReason } from '../../shared/net.js'


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
