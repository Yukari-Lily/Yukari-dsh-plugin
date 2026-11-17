/**
 * `/ssproxy/api` 的导入动作：预览 → 选择 → 导入的路由分派与拒绝路径。
 *
 * 预览只解析粘贴的文本，不碰网络也不落盘；订阅链接的抓取由 controller 用例与
 * 面板用例覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../host/proxy/index.js'

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const SIP002 = `ss://${b64url('aes-256-gcm:pass/one+')}@1.2.3.4:8388#HK%2001`
const LEGACY = `ss://${Buffer.from('chacha20-ietf-poly1305:legacy@host.example:1234').toString('base64')}#Legacy`

function response() {
  const chunks = []
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    setHeader(name, value) { res.headers[name.toLowerCase()] = value },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      res.headersSent = true
    },
    json() {
      const text = Buffer.concat(chunks).toString('utf8')
      return text === '' ? null : JSON.parse(text)
    },
  }
  return res
}

function request(url, { method = 'GET', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    url,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Mount the component row against a temp harness home. */
async function mount(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ss-proxy-api-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  let route = null
  const tools = []
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: (value) => { route = value; return () => {} } },
    connection: { requestRejection: options.reject ? () => 403 : () => undefined },
    effect: (callback) => { const cleanup = callback(); return () => cleanup?.() },
    logger: { warn: () => {}, info: () => {} },
    get: () => undefined,
  }
  apply(ctx, {})
  assert.ok(route !== null, 'the component registered its route')
  // The lifecycle effect starts `controller.init()` without an awaited handle.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const call = async (url, init) => {
    const res = response()
    await route.handler(request(url, init), res)
    return res
  }
  return { call, tools, home }
}

test('preview: multiple pasted nodes become selectable candidates, none stored', async (t) => {
  const { call, home } = await mount(t)
  const preview = await (await call('/ssproxy/api/import/preview', { method: 'POST', body: { text: `${SIP002}\n${LEGACY}` } })).json()
  assert.equal(preview.ok, true)
  assert.equal(preview.candidates.length, 2)
  assert.equal(preview.skipped, 0)
  assert.equal(preview.source, 'text')
  assert.deepEqual(preview.candidates.map((candidate) => candidate.imported), [false, false])
  assert.equal(JSON.stringify(preview).includes('pass/one+'), false, 'the preview carries no passwords')

  const state = await (await call('/ssproxy/api/state')).json()
  assert.deepEqual(state.state.nodes, [], 'a preview does not add nodes')
  await assert.rejects(readFile(path.join(home, 'ss-proxy.json')), /ENOENT/)

  const selected = await (await call('/ssproxy/api/import/select', {
    method: 'POST',
    body: { ids: [preview.candidates[0].id] },
  })).json()
  assert.equal(selected.added, 1)
  assert.equal(selected.state.nodes.length, 1)
  const again = await (await call('/ssproxy/api/state')).json()
  assert.equal(again.state.nodes[0].name, 'HK 01')
})

test('preview: an input with nothing usable answers with an empty list and the skipped count', async (t) => {
  const { call } = await mount(t)
  const vmess = 'proxies:\n  - name: V\n    type: vmess\n    server: 9.9.9.9\n    port: 443\n    uuid: 1\n'
  const result = await (await call('/ssproxy/api/import/preview', { method: 'POST', body: { text: vmess } })).json()
  assert.equal(result.ok, true)
  assert.deepEqual(result.candidates, [])
  assert.equal(result.skipped, 1)

  const empty = await (await call('/ssproxy/api/import/preview', { method: 'POST', body: { text: '  ' } })).json()
  assert.deepEqual(empty.candidates, [])
  assert.equal(empty.skipped, 0)
})

test('select: a stale or empty selection keeps its stable code', async (t) => {
  const { call } = await mount(t)
  const stale = await call('/ssproxy/api/import/select', { method: 'POST', body: { ids: ['missing'] } })
  assert.equal(stale.statusCode, 400)
  assert.equal(stale.json().code, 'proxy-candidates-stale')
  const empty = await call('/ssproxy/api/import/select', { method: 'POST', body: { ids: [] } })
  assert.equal(empty.statusCode, 400)
  assert.equal(empty.json().code, 'proxy-no-selection')
})

test('preview: a config larger than the default body limit is still accepted', async (t) => {
  const { call } = await mount(t)
  // 900 条节点的 Clash 配置约 80 KB，base64 包装后超过 100 KB：默认 64 KB 上限会拒绝它。
  const entries = Array.from({ length: 900 }, (_, index) => [
    `  - name: N${index}`,
    '    type: ss',
    `    server: 10.0.${Math.floor(index / 250)}.${index % 250}`,
    '    port: 8388',
    '    cipher: aes-256-gcm',
    '    password: secret',
  ].join('\n'))
  const config = `proxies:\n${entries.join('\n')}\n`
  const payload = Buffer.from(config).toString('base64')
  assert.ok(payload.length > 64 * 1024, 'the fixture must exceed the default ceiling')
  const result = await (await call('/ssproxy/api/import/preview', { method: 'POST', body: { text: payload } })).json()
  assert.equal(result.ok, true)
  assert.equal(result.candidates.length, 900)
})

test('routing: verbs and unknown actions answer without touching the controller', async (t) => {
  const { call } = await mount(t)
  assert.equal((await call('/ssproxy/api/import/preview')).statusCode, 405)
  const unknown = await call('/ssproxy/api/import/nope', { method: 'POST', body: {} })
  assert.equal(unknown.statusCode, 404)
  assert.match(unknown.json().error, /import\/nope/)
})

test('guard: the connection guard refuses every action', async (t) => {
  const { call } = await mount(t, { reject: true })
  assert.equal((await call('/ssproxy/api/state')).statusCode, 403)
  assert.equal((await call('/ssproxy/api/import/preview', { method: 'POST', body: { text: SIP002 } })).statusCode, 403)
})

test('agent tool: import accepts a subscription URL', async (t) => {
  const { tools } = await mount(t)
  const tool = tools.find((entry) => entry.name === 'ss_proxy')
  assert.ok(tool !== undefined)
  assert.match(tool.parameters.properties.uri.description, /subscription URL/)
})
