/**
 * /publish/api 的路由层：`list` / `settings` / `delete` 的分派、方法限制与
 * 前缀校验。组件自己的 store 测试只覆盖发布/回收逻辑，这里补的是"面板真的
 * 发一个请求会发生什么"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../host/sites/index.js'

/** A response that records status, headers and body. */
function response() {
  const chunks = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  stream.statusCode = 200
  stream.headers = {}
  stream.setHeader = (name, value) => { stream.headers[name.toLowerCase()] = value }
  stream.removeHeader = (name) => { delete stream.headers[name.toLowerCase()] }
  stream.json = () => {
    const text = Buffer.concat(chunks).toString('utf8')
    return text === '' ? null : JSON.parse(text)
  }
  return stream
}

function request(url, { method = 'GET', body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    url,
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function mount(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yk-sites-api-'))
  // 组件的目录是 init() 里懒创建的：挂载后立刻断言再清理，rm 会撞上进行中的
  // mkdir（ENOTEMPTY）。重试几次比让用例随机变红诚实。
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
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
  apply(ctx, { root: path.join(root, 'publish'), stateRoot: path.join(root, 'state'), maxMb: 8, maxFiles: 100 })
  assert.ok(route !== null, 'the component registered a route')
  const call = async (url, init) => {
    const res = response()
    await route.handler(request(url, init), res)
    return { status: res.statusCode, json: res.json(), headers: res.headers }
  }
  return { call, tools, root }
}

test('list: the route answers with sites, root and the active prefix', async (t) => {
  const { call } = await mount(t)
  const result = await call('/publish/api/list')
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.sites, [])
  assert.equal(typeof result.json.publicBase, 'string')
  assert.equal(result.json.customPublicBase, false)
})

test('settings: a prefix on the panel origin is refused with a reason', async (t) => {
  const { call } = await mount(t)
  const result = await call('/publish/api/settings', {
    method: 'POST',
    headers: { host: 'dsh.example.com' },
    body: { publicBase: 'https://dsh.example.com/p' },
  })
  assert.equal(result.status, 400)
  assert.match(result.json.error, /同源/u)
  assert.equal(result.json.code, 'base-forbidden', 'the panel can localize this failure')
})

test('settings: a public prefix is saved and returned', async (t) => {
  const { call } = await mount(t)
  const result = await call('/publish/api/settings', {
    method: 'POST',
    headers: { host: 'dsh.example.com' },
    body: { publicBase: 'https://pages.example.com' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.json.publicBase, 'https://pages.example.com')
  assert.equal(result.json.customPublicBase, true)
  const listed = await call('/publish/api/list')
  assert.equal(listed.json.publicBase, 'https://pages.example.com')
})

test('delete: an unknown slug is a no-op instead of an error', async (t) => {
  const { call } = await mount(t)
  const result = await call('/publish/api/delete', { method: 'POST', body: { slug: 'missing' } })
  assert.equal(result.status, 200)
  assert.equal(result.json.deleted, false)
})

test('methods: reading the API only accepts GET, writes only accept POST', async (t) => {
  const { call } = await mount(t)
  assert.equal((await call('/publish/api/settings')).status, 405)
  assert.equal((await call('/publish/api/list', { method: 'POST', body: {} })).status, 405)
  assert.equal((await call('/publish/api/nope')).status, 405)
  assert.equal((await call('/publish/api/nope', { method: 'POST', body: {} })).status, 404)
})

test('guard: a rejected connection never reaches the handler', async (t) => {
  const { call } = await mount(t, { reject: true })
  const result = await call('/publish/api/list')
  assert.equal(result.status, 403)
})
