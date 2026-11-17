/**
 * Import preview: one input for links, subscriptions and Clash, and a selection
 * before anything joins the node list. The network is stubbed through the
 * controller's `fetch` seam, so these cases stay offline.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { register } from 'node:module'
import os from 'node:os'
import path from 'node:path'

// The controller imports egress.js, which needs `undici`; these tests never
// enable the proxy, so a stub stands in when dependencies are not installed.
try {
  import.meta.resolve('undici')
} catch {
  const stub = 'export class Agent {} export class Pool {} export class ProxyAgent {} export const getGlobalDispatcher = () => null; export const setGlobalDispatcher = () => {}\nexport async function fetch() { throw new Error("undici is stubbed") }'
  const hooks = `export async function resolve(specifier, context, next) {
    if (specifier === 'undici') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)}, shortCircuit: true }
    return next(specifier, context)
  }`
  register(`data:text/javascript,${encodeURIComponent(hooks)}`)
}

const { ProxyController } = await import('../host/proxy/lib/controller.js')
const { fetchSubscription, isSubscriptionUrl, subscriptionUrl } = await import('../host/proxy/lib/subscriptions.js')

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const b64url = (text) => b64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const SIP002 = `ss://${b64url('aes-256-gcm:pass/one+')}@1.2.3.4:8388#HK%2001`
const PLAIN = 'ss://aes-128-gcm:p%40ss@[2001:db8::1]:8443/?#V6 node'
const LEGACY = `ss://${b64('chacha20-ietf-poly1305:legacy@host.example:1234')}#Legacy`
const RC4 = `ss://${b64('rc4-md5:x')}@rc4.example:1`

/** A Clash config whose first entry duplicates SIP002 and whose second is unsupported. */
const CLASH = `port: 7890
proxies:
  - name: HK 01
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-256-gcm
    password: pass/one+
  - name: Relayed
    type: vmess
    server: 5.6.7.8
    port: 443
    uuid: 00000000-0000-0000-0000-000000000000
`

const VMESS_ONLY = `proxies:
  - name: Only VMess
    type: vmess
    server: 9.9.9.9
    port: 443
    uuid: 00000000-0000-0000-0000-000000000000
`

/** Fresh temp state file per controller test. */
async function tempStateFile(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ss-proxy-import-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return path.join(directory, 'ss-proxy.json')
}

/** A controller whose URL fetches answer from `routes`. */
async function makeController(t, routes = {}) {
  const stateFile = await tempStateFile(t)
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    const body = routes[String(url)]
    if (body === undefined) throw new Error('network unreachable')
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  const controller = new ProxyController({ config: { stateFile }, fetch: fetchImpl, subscriptionTimeoutMs: 2000 })
  await controller.init()
  return { controller, stateFile, calls }
}

test('previewImport: a multi-node paste offers every node and stores nothing', async (t) => {
  const { controller, stateFile } = await makeController(t)
  const preview = await controller.previewImport(`${SIP002}\n${LEGACY}\n${RC4}`)
  assert.equal(preview.candidates.length, 2)
  assert.equal(preview.skipped, 1)
  assert.equal(preview.candidates[0].name, 'HK 01')
  assert.equal(preview.candidates[1].name, 'Legacy')
  assert.deepEqual(preview.candidates.map((candidate) => candidate.imported), [false, false])
  assert.equal(controller.state().nodes.length, 0, 'a preview never fills the node list')
  await assert.rejects(readFile(stateFile), /ENOENT/, 'a preview writes no state file')

  const text = JSON.stringify(preview)
  for (const secret of ['pass/one+', 'legacy']) assert.equal(text.includes(secret), false)
  assert.equal(text.includes('"password"'), false)
})

test('previewImport: one input dedupes repeated nodes and counts what it skips', async (t) => {
  const { controller } = await makeController(t)
  const links = await controller.previewImport(`${SIP002}\n${SIP002}\n${RC4}`)
  assert.equal(links.candidates.length, 1, 'the same link twice is one candidate')
  assert.equal(links.skipped, 1)
  assert.equal(links.candidates[0].name, 'HK 01')

  const clash = await controller.previewImport(CLASH)
  assert.equal(clash.candidates.length, 1)
  assert.equal(clash.skipped, 1, 'a non-Shadowsocks proxy entry is counted, not fatal')
  assert.equal(clash.candidates[0].method, 'aes-256-gcm')
})

test('previewImport: a subscription URL is fetched, offered, and not remembered', async (t) => {
  const { controller, calls, stateFile } = await makeController(t, {
    'https://sub.example.com/clash': CLASH,
    'https://sub.example.com/base64': b64(`${SIP002}\n${PLAIN}`),
  })
  const first = await controller.previewImport('https://sub.example.com/clash')
  assert.deepEqual(calls, ['https://sub.example.com/clash'])
  assert.equal(first.candidates.length, 1)
  assert.equal(first.skipped, 1)
  assert.equal(first.source, 'subscription', 'a link is always offered as a choice, even with one node')

  const second = await controller.previewImport(b64(`${SIP002}\n${PLAIN}`))
  assert.equal(second.candidates.length, 2)
  assert.equal(second.source, 'text')
  assert.equal(calls.length, 1, 'base64 content is not a URL and needs no fetch')

  const state = controller.state()
  assert.equal(state.nodes.length, 0)
  assert.equal(JSON.stringify(state).includes('sub.example.com'), false, 'the link is not stored or echoed back')
  await assert.rejects(readFile(stateFile), /ENOENT/)
})

test('previewImport: a base64-wrapped Clash config is unwrapped before parsing', async (t) => {
  const { controller } = await makeController(t)
  const preview = await controller.previewImport(b64(CLASH))
  assert.equal(preview.candidates.length, 1)
  assert.equal(preview.skipped, 1)
  assert.equal(preview.candidates[0].name, 'HK 01')
})

test('previewImport: an input with nothing usable is an empty result, not a failure', async (t) => {
  const { controller } = await makeController(t)
  const vmess = await controller.previewImport(VMESS_ONLY)
  assert.deepEqual(vmess, { candidates: [], skipped: 1, truncated: 0, source: 'text' })
  const empty = await controller.previewImport('   ')
  assert.deepEqual(empty, { candidates: [], skipped: 0, truncated: 0, source: 'text' })
})

test('importCandidates: only the selected ids are imported; stale ids fail', async (t) => {
  const { controller } = await makeController(t)
  const preview = await controller.previewImport(`${SIP002}\n${LEGACY}`)
  const [first, second] = preview.candidates.map((candidate) => candidate.id)

  await assert.rejects(controller.importCandidates([]), (error) => error.appCode === 'proxy-no-selection')
  const one = await controller.importCandidates([first])
  assert.equal(one.added, 1)
  assert.equal(one.state.nodes.length, 1)
  assert.equal(one.state.nodes[0].name, 'HK 01')

  const rest = await controller.importCandidates([second])
  assert.equal(rest.added, 1)
  assert.equal(rest.state.nodes.length, 2)

  const again = await controller.previewImport(`${SIP002}\n${LEGACY}`)
  assert.deepEqual(again.candidates.map((candidate) => candidate.imported), [true, true])
  const updated = await controller.importCandidates([again.candidates[0].id])
  assert.equal(updated.added, 0)
  assert.equal(updated.updated, 1, 'importing a stored node refreshes it instead of duplicating')

  await assert.rejects(controller.importCandidates([first]), (error) => error.appCode === 'proxy-candidates-stale')
})

test('importNodes: a subscription URL still imports every node for the agent tool', async (t) => {
  const { controller, stateFile } = await makeController(t, {
    'https://sub.example.com/base64': b64(`${SIP002}\n${PLAIN}`),
  })
  const result = await controller.importNodes('https://sub.example.com/base64')
  assert.equal(result.added, 2)
  assert.equal(result.state.nodes.length, 2)
  assert.equal(result.url, 'https://sub.example.com/base64')

  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal('subscriptions' in saved, false, 'the state file only holds nodes and settings')
  assert.equal(saved.nodes.length, 2)
  await assert.rejects(controller.importNodes('https://dead.example.com/sub'), /network unreachable/)
})

test('subscription links: the URL helpers accept http(s) only', () => {
  assert.equal(subscriptionUrl(' https://example.com/sub '), 'https://example.com/sub')
  assert.throws(() => subscriptionUrl('example.com/sub'), /not a valid URL/)
  assert.throws(() => subscriptionUrl('ftp://example.com/sub'), /http or https/)
  assert.equal(isSubscriptionUrl('https://example.com/sub'), true)
  assert.equal(isSubscriptionUrl(SIP002), false)
  assert.equal(isSubscriptionUrl(CLASH), false)
  assert.equal(isSubscriptionUrl('https://example.com/a\nhttps://example.com/b'), false)
})

test('subscription links: early failures cancel an unread response body', async () => {
  for (const init of [
    { status: 403 },
    { status: 200, headers: { 'content-type': 'text/html' } },
    { status: 200, headers: { 'content-length': '100' } },
  ]) {
    let cancelled = 0
    const stream = new ReadableStream({ cancel() { cancelled += 1 } })
    await assert.rejects(fetchSubscription('https://example.com/sub', {
      fetch: async () => new Response(stream, init),
      maxBytes: 16,
    }))
    assert.equal(cancelled, 1)
  }
})

test('subscription links: fetch sends a Clash agent and refuses broken answers', async () => {
  let seen = null
  const body = await fetchSubscription('https://example.com/sub', {
    fetch: async (url, init) => {
      seen = { url, init }
      return new Response(SIP002, { status: 200 })
    },
  })
  assert.equal(body, SIP002)
  assert.equal(seen.url, 'https://example.com/sub')
  assert.match(seen.init.headers['user-agent'], /clash/i, 'providers key the response format on this agent')
  assert.ok(seen.init.signal instanceof AbortSignal)

  await assert.rejects(fetchSubscription('https://example.com/sub', { fetch: async () => new Response('no', { status: 403 }) }), /HTTP 403/)
  await assert.rejects(
    fetchSubscription('https://example.com/sub', {
      fetch: async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    }),
    /HTML page/,
  )
  await assert.rejects(fetchSubscription('https://example.com/sub', { fetch: async () => new Response('') }), /empty body/)
  await assert.rejects(
    fetchSubscription('https://example.com/sub', { fetch: async () => new Response(`${SIP002}\n${PLAIN}`), maxBytes: 16 }),
    /larger than/,
  )
  await assert.rejects(
    fetchSubscription('https://example.com/sub', {
      fetch: async () => {
        throw new DOMException('timed out', 'TimeoutError')
      },
    }),
    /did not answer within 15s/,
  )
})
