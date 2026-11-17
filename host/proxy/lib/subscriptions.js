/**
 * Subscription links: validate a URL, fetch its body, and hand the text to the
 * node parser.
 *
 * A Clash / Shadowsocks subscription is an HTTP(S) URL that answers with a
 * Clash YAML config, a base64 blob of share links, or a JSON node list. This
 * module owns only the network half; which nodes are usable is decided by
 * `ss-uri.js`.
 * @module @local/ss-proxy/subscriptions
 */
import { fetch as undiciFetch } from 'undici'

/** How long one subscription may take before the load is abandoned. */
export const SUBSCRIPTION_TIMEOUT_MS = 15000

/** Ceiling for one response; a Clash config with thousands of nodes stays far below. */
export const SUBSCRIPTION_MAX_BYTES = 5 * 1024 * 1024

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Accept only an absolute http(s) URL.
 * @param value - pasted or stored link.
 * @returns the normalized URL.
 * @throws when the text is not one.
 */
export function subscriptionUrl(value) {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error('subscription URL is required')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('subscription URL is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('subscription URL must use http or https')
  return url.href
}

/** Whether a whole pasted text is one subscription URL rather than node data. */
export function isSubscriptionUrl(value) {
  const text = String(value ?? '').trim()
  if (!/^https?:\/\/\S+$/i.test(text)) return false
  try {
    subscriptionUrl(text)
    return true
  } catch {
    return false
  }
}

/** Release a response connection when its body will not be consumed. */
async function discardBody(response) {
  if (response.body !== null) await response.body.cancel().catch(() => undefined)
}

/**
 * Read a response body with a byte ceiling.
 *
 * The ceiling is enforced while reading: a server that understates its length
 * must not be able to buffer more than the ceiling in memory.
 * @throws when the body exceeds `maxBytes`.
 */
async function readBody(response, maxBytes) {
  const limit = `subscription response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response)
    throw new Error(limit)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(limit)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Fetch one subscription body.
 *
 * The User-Agent is the part subscription providers key on: they answer a Clash
 * client with a Clash config and any other client with whatever else they serve
 * (often an HTML page), so a browser-like agent would parse as "no nodes".
 *
 * The request goes through undici's global dispatcher, which is what the egress
 * route replaces while the proxy is on; it therefore follows the configured
 * node whenever the route is up and goes direct otherwise.
 *
 * @param url - the subscription link.
 * @param options.fetch - test seam replacing `undici.fetch`.
 * @param options.timeoutMs - per-request budget.
 * @param options.maxBytes - response ceiling.
 * @returns the body text.
 * @throws when the URL, the transport, the status, or the body is unusable.
 */
export async function fetchSubscription(url, options = {}) {
  const target = subscriptionUrl(url)
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : undiciFetch
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : SUBSCRIPTION_TIMEOUT_MS
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : SUBSCRIPTION_MAX_BYTES
  let response
  try {
    response = await fetchImpl(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'clash-verge/v2.0.0',
        accept: '*/*',
      },
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`subscription did not answer within ${Math.round(timeoutMs / 1000)}s`)
    }
    throw new Error(`subscription request failed: ${messageOf(error)}`)
  }
  if (!response.ok) {
    await discardBody(response)
    throw new Error(`subscription answered HTTP ${response.status}`)
  }
  const type = String(response.headers.get('content-type') ?? '').toLowerCase()
  if (type.includes('text/html')) {
    await discardBody(response)
    throw new Error('subscription answered with an HTML page; the link or its token may be wrong')
  }
  const text = await readBody(response, maxBytes)
  if (text.trim() === '') throw new Error('subscription returned an empty body')
  return text
}
