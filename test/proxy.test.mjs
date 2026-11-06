import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { parseNodeInput, parseNodesInput } from '../host/proxy/lib/ss-uri.js'
import { METHOD_NAMES } from '../host/proxy/lib/shadowsocks.js'

// The controller imports egress.js, which needs `undici`; these tests never
// enable the proxy, so a stub stands in when dependencies are not installed.
try {
  import.meta.resolve('undici')
} catch {
  const stub = 'export class Agent {} export class Pool {} export class ProxyAgent {} export const getGlobalDispatcher = () => null; export const setGlobalDispatcher = () => {}'
  const hooks = `export async function resolve(specifier, context, next) {
    if (specifier === 'undici') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)}, shortCircuit: true }
    return next(specifier, context)
  }`
  register(`data:text/javascript,${encodeURIComponent(hooks)}`)
}
const { ProxyController } = await import('../host/proxy/lib/controller.js')

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const b64url = (text) => b64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const SIP002 = `ss://${b64url('aes-256-gcm:pass/one+')}@1.2.3.4:8388#HK%2001`
const PLAIN = 'ss://aes-128-gcm:p%40ss@[2001:db8::1]:8443/?#V6 node'
const LEGACY = `ss://${b64('chacha20-ietf-poly1305:legacy@host.example:1234')}#Legacy`
const RC4 = `ss://${b64('rc4-md5:x')}@rc4.example:1`

/** Fresh temp state file per controller test. */
async function tempStateFile(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ss-proxy-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return path.join(directory, 'ss-proxy.json')
}

test('parseNodesInput: several ss:// lines (SIP002 base64, plain, legacy)', () => {
  const { nodes, skipped } = parseNodesInput(`my nodes:\n${SIP002}\n\n  ${PLAIN}\n${LEGACY}\n`, METHOD_NAMES)
  assert.equal(skipped, 0)
  assert.deepEqual(nodes, [
    { server: '1.2.3.4', port: 8388, method: 'aes-256-gcm', password: 'pass/one+', name: 'HK 01' },
    { server: '2001:db8::1', port: 8443, method: 'aes-128-gcm', password: 'p@ss', name: 'V6 node' },
    { server: 'host.example', port: 1234, method: 'chacha20-ietf-poly1305', password: 'legacy', name: 'Legacy' },
  ])
})

test('parseNodesInput: links on one line separated by spaces', () => {
  const { nodes } = parseNodesInput(`${SIP002} ${LEGACY}`, METHOD_NAMES)
  assert.deepEqual(nodes.map((node) => node.name), ['HK 01', 'Legacy'])
})

test('parseNodesInput: base64 subscription with mixed schemes', () => {
  const blob = b64([SIP002, 'vmess://eyJhZGQiOiJ4In0=', 'trojan://pw@t.example:443#T', RC4, LEGACY].join('\n'))
  const wrapped = blob.replace(/(.{40})/g, '$1\n')
  const { nodes, skipped } = parseNodesInput(wrapped, METHOD_NAMES)
  assert.equal(nodes.length, 2)
  assert.equal(skipped, 3)
  assert.equal(nodes[1].server, 'host.example')
  // base64url without padding is accepted too.
  assert.equal(parseNodesInput(b64url(SIP002), METHOD_NAMES).nodes[0].password, 'pass/one+')
})

test('parseNodesInput: Clash YAML flow-map entries', () => {
  const yaml = [
    'port: 7890',
    'proxies:',
    '  - {name: "HK 01", type: ss, server: a.b.c, port: 443, cipher: aes-256-gcm, password: "x, y"}',
    '  - {name: VM, type: vmess, server: v.example, port: 443, uuid: abc}',
    "  - {name: 'Obfs', type: ss, server: o.example, port: 1, cipher: aes-256-gcm, password: p, plugin: obfs, plugin-opts: {mode: tls}}",
    'proxy-groups:',
    '  - name: G',
    '    type: select',
  ].join('\n')
  const { nodes, skipped } = parseNodesInput(yaml, METHOD_NAMES)
  assert.deepEqual(nodes, [{ server: 'a.b.c', port: 443, method: 'aes-256-gcm', password: 'x, y', name: 'HK 01' }])
  assert.equal(skipped, 2)
})

test('parseNodesInput: Clash YAML block-style entries', () => {
  const yaml = [
    'proxies:',
    '- name: "SG 01"   # comment',
    '  type: ss',
    '  server: sg.example',
    '  port: 8443',
    '  cipher: chacha20-ietf-poly1305',
    "  password: 'it''s #secret'",
    '  udp: true',
    '- name: Plug',
    '  type: ss',
    '  server: p.example',
    '  port: 1',
    '  cipher: aes-128-gcm',
    '  password: x',
    '  plugin: v2ray-plugin',
    '  plugin-opts:',
    '    mode: websocket',
    '- name: R',
    '  type: ss',
    '  server: r.example',
    '  port: 2',
    '  cipher: rc4-md5',
    '  password: y',
    '-',
    '  name: Late',
    '  type: ss',
    '  server: late.example',
    '  port: 3',
    '  cipher: aes-128-gcm',
    '  password: 12345',
    'rules:',
    '  - MATCH,DIRECT',
  ].join('\n')
  const { nodes, skipped } = parseNodesInput(yaml, METHOD_NAMES)
  assert.deepEqual(nodes, [
    { server: 'sg.example', port: 8443, method: 'chacha20-ietf-poly1305', password: "it's #secret", name: 'SG 01' },
    { server: 'late.example', port: 3, method: 'aes-128-gcm', password: '12345', name: 'Late' },
  ])
  assert.equal(skipped, 2)
})

test('parseNodesInput: JSON { proxies: [...] } and pasted objects', () => {
  const json = JSON.stringify({
    proxies: [
      { name: 'J1', type: 'ss', server: 'j.example', port: 1, cipher: 'AES-256-GCM', password: 'pw' },
      { name: 'T', type: 'trojan', server: 't.example', port: 443, password: 'pw' },
    ],
  })
  const parsed = parseNodesInput(json, METHOD_NAMES)
  assert.deepEqual(parsed.nodes, [{ server: 'j.example', port: 1, method: 'aes-256-gcm', password: 'pw', name: 'J1' }])
  assert.equal(parsed.skipped, 1)
  const pasted = '{"server":"a.example","port":2,"method":"aes-128-gcm","password":"a"}\n{"server":"b.example","port":3,"cipher":"aes-128-gcm","password":"b"}'
  assert.deepEqual(parseNodesInput(pasted, METHOD_NAMES).nodes.map((node) => node.server), ['a.example', 'b.example'])
})

test('parseNodesInput: unsupported cipher is skipped, not fatal', () => {
  const { nodes, skipped } = parseNodesInput(`${RC4}\n${SIP002}`, METHOD_NAMES)
  assert.equal(nodes.length, 1)
  assert.equal(skipped, 1)
})

test('parseNodesInput: nothing usable throws with the skipped count', () => {
  assert.throws(() => parseNodesInput(`vmess://abc\n${RC4}`, METHOD_NAMES), /skipped 2/)
  assert.throws(() => parseNodesInput('hello there', METHOD_NAMES), /expected ss:\/\/ links/)
  assert.throws(() => parseNodesInput('', METHOD_NAMES), /paste/)
})

test('parseNodeInput: still returns the first node', () => {
  assert.equal(parseNodeInput(`${LEGACY}\n${SIP002}`, METHOD_NAMES).server, 'host.example')
})

test('controller: import adds nodes, dedupes, and activates the first', async (t) => {
  const stateFile = await tempStateFile(t)
  const controller = new ProxyController({ config: { stateFile } })
  await controller.init()
  const first = await controller.importNodes(`${SIP002}\n${LEGACY}\n${RC4}`)
  assert.equal(first.added, 2)
  assert.equal(first.updated, 0)
  assert.equal(first.skipped, 1)
  assert.equal(first.state.nodes.length, 2)
  assert.equal(first.state.activeId, first.state.nodes[0].id)
  assert.equal(first.state.node.server, '1.2.3.4')
  assert.equal(first.state.nodes[0].active, true)

  const renamed = SIP002.replace('#HK%2001', '#Hong Kong')
  const second = await controller.importNodes(`${renamed}\n${PLAIN}`)
  assert.equal(second.added, 1)
  assert.equal(second.updated, 1)
  assert.equal(second.state.nodes.length, 3)
  assert.equal(second.state.nodes[0].name, 'Hong Kong')
  assert.equal(second.state.activeId, first.state.activeId)

  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.nodes.length, 3)
  assert.equal(saved.activeId, first.state.activeId)
  assert.equal(saved.nodes[0].password, 'pass/one+')

  // A second controller on the same file resumes the same list.
  const reloaded = new ProxyController({ config: { stateFile } })
  await reloaded.init()
  assert.deepEqual(reloaded.state().nodes, controller.state().nodes)
})

test('controller: select and remove', async (t) => {
  const stateFile = await tempStateFile(t)
  const controller = new ProxyController({ config: { stateFile } })
  await controller.init()
  const { state } = await controller.importNodes(`${SIP002}\n${LEGACY}\n${PLAIN}`)
  const [a, b, c] = state.nodes.map((node) => node.id)

  const selected = await controller.select(b)
  assert.equal(selected.activeId, b)
  assert.equal(selected.node.server, 'host.example')
  assert.deepEqual(selected.nodes.map((node) => node.active), [false, true, false])
  await assert.rejects(controller.select('nope'), /unknown node/)
  assert.equal(controller.state().activeId, b)

  const removed = await controller.removeNode(b)
  assert.deepEqual(removed.nodes.map((node) => node.id), [a, c])
  assert.equal(removed.activeId, a)
  const other = await controller.removeNode(c)
  assert.equal(other.activeId, a)
  const empty = await controller.removeNode(a)
  assert.equal(empty.activeId, null)
  assert.deepEqual(empty.nodes, [])
  assert.deepEqual(empty.node, { server: '', port: 8388, method: 'aes-256-gcm', hasPassword: false })
  await assert.rejects(controller.enable(), /add a Shadowsocks node first/)
})

test('controller: configure edits a node by id or creates the first one', async (t) => {
  const stateFile = await tempStateFile(t)
  const controller = new ProxyController({ config: { stateFile } })
  await controller.init()
  const created = await controller.configure({ server: 'new.example', port: 9000, method: 'aes-128-gcm', password: 'pw', localPort: 18000 })
  assert.equal(created.nodes.length, 1)
  assert.equal(created.nodes[0].name, 'new.example')
  assert.equal(created.activeId, created.nodes[0].id)
  assert.equal(created.localPort, 18000)

  const { state } = await controller.importNodes(LEGACY)
  const legacyId = state.nodes[1].id
  const edited = await controller.configure({ id: legacyId, name: 'Renamed', port: 4321 })
  assert.equal(edited.nodes[1].name, 'Renamed')
  assert.equal(edited.nodes[1].port, 4321)
  assert.equal(edited.activeId, created.activeId)
  await assert.rejects(controller.configure({ id: 'missing', port: 1 }), /unknown node/)

  const reset = await controller.reset()
  assert.deepEqual(reset.nodes, [])
  assert.equal(reset.activeId, null)
})

test('controller: init migrates the legacy single node', async (t) => {
  const stateFile = await tempStateFile(t)
  await writeFile(stateFile, JSON.stringify({ enabled: false, node: { server: 'old.example', port: 1234, method: 'aes-128-gcm', password: 'oldpw' }, localPort: 17999 }))
  const controller = new ProxyController({ config: { stateFile } })
  await controller.init()
  const state = controller.state()
  assert.equal(state.nodes.length, 1)
  assert.equal(state.nodes[0].name, 'old.example')
  assert.equal(state.nodes[0].hasPassword, true)
  assert.equal(state.activeId, state.nodes[0].id)
  assert.deepEqual(state.node, { server: 'old.example', port: 1234, method: 'aes-128-gcm', hasPassword: true })
  assert.equal(state.localPort, 17999)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.node, undefined)
  assert.equal(saved.nodes[0].password, 'oldpw')
  assert.equal(saved.activeId, state.activeId)
})

test('controller: state() never carries passwords', async (t) => {
  const stateFile = await tempStateFile(t)
  const controller = new ProxyController({ config: { stateFile } })
  await controller.init()
  const result = await controller.importNodes(`${SIP002}\n${LEGACY}\n${PLAIN}`)
  const text = JSON.stringify([result, controller.state()])
  for (const secret of ['pass/one+', 'legacy', 'p@ss']) assert.equal(text.includes(`"${secret}"`), false)
  assert.equal(/"password"/.test(text), false)
})

/** Reserve an unused loopback port, then release it for the controller. */
async function unusedPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

const healthyProbe = async () => ({ ok: true, status: 204, ms: 1, at: new Date().toISOString() })

/** Poll until `check()` is true, or fail the test after `timeoutMs`. */
async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('condition did not become true in time')
}

test('controller: a failed enable restores direct egress and persists off', async (t) => {
  const stateFile = await tempStateFile(t)
  const localPort = await unusedPort()
  const controller = new ProxyController({
    config: { stateFile, localPort },
    probeThrough: async () => { throw new Error('bad node credentials') },
  })
  t.after(() => controller.dispose())
  await controller.importNodes(SIP002)
  await assert.rejects(controller.enable(), /bad node credentials/)
  assert.equal(controller.state().enabled, false)
  assert.equal(controller.state().running, false)
  assert.equal(controller.state().egress, null)
  assert.match(controller.state().lastError, /disabled automatically.*bad node credentials/)
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).enabled, false)
  await controller.dispose()
})

test('controller: startup with an incomplete saved node turns the saved route off', async (t) => {
  const stateFile = await tempStateFile(t)
  await writeFile(stateFile, JSON.stringify({
    enabled: true,
    activeId: 'broken',
    nodes: [{ id: 'broken', server: 'node.example', port: 8388, method: 'aes-256-gcm', password: '' }],
  }))
  const controller = new ProxyController({ config: { stateFile } })
  await controller.init()
  t.after(() => controller.dispose())
  assert.equal(controller.state().enabled, false)
  assert.equal(controller.state().running, false)
  assert.equal(controller.state().egress, null)
  assert.match(controller.state().lastError, /disabled automatically/)
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).enabled, false)
})

test('controller: a failed reconnect at startup keeps the saved intent', async (t) => {
  // A restart races the network: one ECONNRESET used to clear `enabled` and leave
  // every later request direct (which in this deployment means none at all).
  const stateFile = await tempStateFile(t)
  const localPort = await unusedPort()
  await writeFile(stateFile, JSON.stringify({
    enabled: true,
    activeId: 'n1',
    localPort,
    nodes: [{ id: 'n1', server: 'node.example', port: 8388, method: 'aes-256-gcm', password: 'secret' }],
  }))
  const controller = new ProxyController({
    config: { stateFile },
    restoreRetryMs: [0, 20, 20],
    probeThrough: async () => { throw new Error('read ECONNRESET') },
  })
  t.after(() => controller.dispose())
  await controller.init()
  assert.equal(await controller.settle(), false, 'every attempt failed')
  assert.equal(controller.state().enabled, true, 'the saved intent survives a transient failure')
  assert.equal(controller.state().running, false)
  assert.equal(controller.state().egress, null)
  assert.match(controller.state().lastError, /已保留启用状态/)
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).enabled, true)
})

test('controller: the startup reconnect recovers on a later attempt', async (t) => {
  const stateFile = await tempStateFile(t)
  const localPort = await unusedPort()
  await writeFile(stateFile, JSON.stringify({
    enabled: true,
    activeId: 'n1',
    localPort,
    nodes: [{ id: 'n1', server: 'node.example', port: 8388, method: 'aes-256-gcm', password: 'secret' }],
  }))
  let attempts = 0
  const controller = new ProxyController({
    config: { stateFile },
    restoreRetryMs: [0, 20, 20],
    probeThrough: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('read ECONNRESET')
      return healthyProbe()
    },
  })
  t.after(() => controller.dispose())
  await controller.init()
  assert.equal(await controller.settle(), true)
  assert.equal(controller.state().running, true)
  assert.equal(controller.state().enabled, true)
  await controller.dispose()
  assert.equal(controller.state().running, false)
})

test('controller: an active probe failure closes the route; another node does not', async (t) => {
  const stateFile = await tempStateFile(t)
  const localPort = await unusedPort()
  let fail = false
  const controller = new ProxyController({
    config: { stateFile, localPort },
    probeThrough: async () => {
      if (fail) throw new Error('upstream unavailable')
      return healthyProbe()
    },
  })
  t.after(() => controller.dispose())
  const { state } = await controller.importNodes(`${SIP002}\n${LEGACY}`)
  const [active, other] = state.nodes.map((node) => node.id)
  await controller.enable()
  assert.equal(controller.state().running, true)
  fail = true
  await assert.rejects(controller.test(undefined, other), /upstream unavailable/)
  assert.equal(controller.state().enabled, true, 'a standby node failure leaves the active route alone')
  assert.equal(controller.state().running, true)
  await assert.rejects(controller.test(undefined, active), /upstream unavailable/)
  assert.equal(controller.state().enabled, false)
  assert.equal(controller.state().running, false)
  assert.equal(controller.state().egress, null)
})

test('controller: a running upstream failure closes the route and a stale error is ignored', async (t) => {
  const stateFile = await tempStateFile(t)
  const localPort = await unusedPort()
  const controller = new ProxyController({ config: { stateFile, localPort }, probeThrough: healthyProbe })
  t.after(() => controller.dispose())
  const { state } = await controller.importNodes(SIP002)
  // The node answered the probe at enable time but now refuses every tunnel,
  // which is exactly the failure a single startup check cannot catch.
  await controller.configure({ id: state.nodes[0].id, server: '127.0.0.1', port: 1 })
  await controller.enable()
  const client = net.connect({ host: '127.0.0.1', port: localPort })
  t.after(() => client.destroy())
  await new Promise((resolve, reject) => client.once('connect', resolve).once('error', reject))
  client.end('CONNECT invalid.example:443 HTTP/1.1\r\nHost: invalid.example:443\r\n\r\n')
  await waitFor(() => controller.state().enabled === false)
  assert.equal(controller.state().running, false)
  assert.equal(controller.state().egress, null)
  assert.match(controller.state().lastError, /disabled automatically/)
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).enabled, false)
  await controller.enable()
  assert.equal(controller.state().enabled, true, 'a late callback from the old sockets cannot close this new route')
  assert.equal(controller.state().running, true)
})

test('controller: selecting an unusable node fails closed without changing activeId', async (t) => {
  const stateFile = await tempStateFile(t)
  const localPort = await unusedPort()
  const controller = new ProxyController({
    config: { stateFile, localPort },
    probeThrough: async (node) => {
      if (node.server === 'host.example') throw new Error('new node failed')
      return healthyProbe()
    },
  })
  t.after(() => controller.dispose())
  const { state } = await controller.importNodes(`${SIP002}\n${LEGACY}`)
  const [active, other] = state.nodes.map((node) => node.id)
  await controller.enable()
  await assert.rejects(controller.select(other), /new node failed/)
  assert.equal(controller.state().enabled, false)
  assert.equal(controller.state().running, false)
  assert.equal(controller.state().activeId, active)
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).enabled, false)
})

test('controller: the health watchdog closes a route whose node stops answering', async (t) => {
  const stateFile = await tempStateFile(t)
  const localPort = await unusedPort()
  let healthy = true
  const controller = new ProxyController({
    config: { stateFile, localPort },
    watchdogIntervalMs: 25,
    probeThrough: async () => {
      if (!healthy) throw new Error('node stopped answering')
      return healthyProbe()
    },
  })
  t.after(() => controller.dispose())
  await controller.importNodes(SIP002)
  await controller.enable()
  assert.equal(controller.state().running, true)
  healthy = false
  // The in-memory flag flips before the atomic write lands; wait for both.
  const persistedOff = () => {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8')).enabled === false
    } catch {
      return false
    }
  }
  await waitFor(() => controller.state().enabled === false && persistedOff())
  assert.equal(controller.state().running, false)
  assert.equal(controller.state().egress, null)
  assert.match(controller.state().lastError, /health checks failed/)
})

test('controller: a restart clears inherited proxy variables that point at the dead port', async (t) => {
  const stateFile = await tempStateFile(t)
  const saved = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
    CORPORATE_PROXY: process.env.CORPORATE_PROXY,
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })
  await writeFile(stateFile, JSON.stringify({ enabled: false, nodes: [], localPort: 17890 }))
  process.env.HTTP_PROXY = 'http://127.0.0.1:17890'
  process.env.http_proxy = 'http://127.0.0.1:17890'
  process.env.HTTPS_PROXY = 'http://corp.example:3128'
  process.env.NO_PROXY = 'localhost,127.0.0.1'
  process.env.NODE_USE_ENV_PROXY = '1'
  const controller = new ProxyController({ config: { stateFile } })
  await controller.init()
  assert.equal(process.env.HTTP_PROXY, undefined, 'the dead self-referential route is gone')
  assert.equal(process.env.http_proxy, undefined)
  assert.equal(process.env.NODE_USE_ENV_PROXY, undefined)
  assert.equal(process.env.HTTPS_PROXY, 'http://corp.example:3128', 'an unrelated proxy is left alone')
  assert.equal(process.env.NO_PROXY, 'localhost,127.0.0.1', 'the direct list is left alone')
})

test('egress: dispose restores direct access instead of a self-referential proxy', async (t) => {
  const { installEgress } = await import('../host/proxy/lib/egress.js')
  const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })
  const port = await unusedPort()
  process.env.HTTP_PROXY = `http://127.0.0.1:${port}`
  process.env.http_proxy = `http://127.0.0.1:${port}`
  const egress = await installEgress({ port, bypass: 'localhost' })
  assert.equal(process.env.HTTP_PROXY, `http://127.0.0.1:${port}`)
  await egress.dispose()
  assert.equal(process.env.HTTP_PROXY, undefined, 'restoring a dead self-route would break every request')
  assert.equal(process.env.http_proxy, undefined)
})

test('controller: turning the route off clears proxy variables for our own port', async (t) => {
  const stateFile = await tempStateFile(t)
  const controller = new ProxyController({ config: { stateFile } })
  await controller.init()
  const port = controller.state().localPort
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
  const saved = new Map([...names, 'NODE_USE_ENV_PROXY'].map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  })
  for (const name of names) process.env[name] = `http://127.0.0.1:${port}`
  process.env.NODE_USE_ENV_PROXY = '1'

  await controller.disable()

  for (const name of names) assert.equal(process.env[name], undefined, `${name} would send children into a dead port`)
  assert.equal(process.env.NODE_USE_ENV_PROXY, undefined)
})
