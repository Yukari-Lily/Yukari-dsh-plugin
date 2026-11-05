import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import os from 'node:os'
import path from 'node:path'
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
