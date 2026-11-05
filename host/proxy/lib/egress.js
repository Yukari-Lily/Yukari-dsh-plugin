/**
 * Process-wide egress takeover.
 *
 * Node's `fetch` resolves a global undici dispatcher, so replacing it routes
 * every `fetch()` caller — the LLM provider stack, web search/fetch, HTTP MCP —
 * through the local proxy. Child processes and Chromium read the standard
 * proxy environment variables, which this module publishes alongside it.
 * Loopback and the configured bypass list stay direct.
 * @module @local/ss-proxy/egress
 */
import { Agent, Pool, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

/** Proxy variables published for children (Chromium, curl, git, pnpm). */
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']

/** Bypass list variables. */
const BYPASS_NAMES = ['NO_PROXY', 'no_proxy']

/** Loopback names that never go through the proxy. */
const LOOPBACK_PATTERN = /^(localhost|127(\.\d{1,3}){3}|::1|0(\.0){3}|::ffff:127(\.\d{1,3}){3})$/i

/** Split a bypass string into normalized entries. */
function bypassEntries(text) {
  return String(text ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
}

/** Whether one host bypasses the proxy. */
export function isBypassed(hostname, bypass) {
  const host = String(hostname ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (host.length === 0 || LOOPBACK_PATTERN.test(host)) return true
  for (const entry of bypassEntries(bypass)) {
    if (entry === '*') return true
    const withoutPort = entry.replace(/:\d+$/, '')
    const pattern = withoutPort.replace(/^\*?\./, '')
    if (host === pattern || host.endsWith(`.${pattern}`)) return true
  }
  return false
}

/**
 * Install the local proxy as this process's egress route.
 *
 * @param options.port - the local proxy port.
 * @param options.bypass - comma separated host suffixes kept direct.
 * @returns a disposer that restores the previous route and environment.
 */
export async function installEgress({ port, bypass }) {
  const proxyUrl = `http://127.0.0.1:${port}`
  const previousDispatcher = getGlobalDispatcher()
  const previousEnv = new Map()
  for (const name of [...PROXY_NAMES, ...BYPASS_NAMES, 'NODE_USE_ENV_PROXY']) previousEnv.set(name, process.env[name])

  const previousBypass = process.env.NO_PROXY ?? process.env.no_proxy ?? ''
  const merged = [...new Set([...bypassEntries(previousBypass), ...bypassEntries(bypass), 'localhost', '127.0.0.1', '::1'])].join(',')

  const agent = new Agent({
    connections: 64,
    factory(origin, options) {
      const url = new URL(String(origin))
      if (isBypassed(url.hostname, bypass)) return new Pool(origin, options)
      return new ProxyAgent({ ...options, uri: proxyUrl })
    },
  })
  setGlobalDispatcher(agent)
  for (const name of PROXY_NAMES) process.env[name] = proxyUrl
  for (const name of BYPASS_NAMES) process.env[name] = merged
  process.env.NODE_USE_ENV_PROXY = '1'

  let disposed = false
  return {
    proxyUrl,
    noProxy: merged,
    async dispose() {
      if (disposed) return
      disposed = true
      setGlobalDispatcher(previousDispatcher)
      for (const [name, value] of previousEnv) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
      try {
        await agent.close()
      } catch {
        // Closing an already-failed agent is not an error worth surfacing.
      }
    },
  }
}
