/**
 * 主行的 HTTP 面：`/yukari/api` 的分派、连接栅栏与图标。
 *
 * 这个路由是面板与宿主之间唯一的主入口，但此前没有任何用例真的调用它；
 * 更新与重启会真的动进程，所以这里只覆盖只读与拒绝路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

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
    body: () => Buffer.concat(chunks),
    json() {
      const text = res.body().toString('utf8')
      return text === '' ? null : JSON.parse(text)
    },
  }
  return res
}

function request(url, { method = 'GET' } = {}) {
  return {
    url,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {},
  }
}

function mount(options = {}, applyPlugin = apply) {
  let route = null
  const ctx = {
    webServer: { register: (value) => { route = value; return () => {} } },
    connection: { requestRejection: options.reject ? () => 403 : () => undefined },
    effect: (callback) => { const cleanup = callback(); return () => cleanup?.() },
    logger: { warn: () => {}, info: () => {} },
    get: () => undefined,
  }
  applyPlugin(ctx)
  assert.ok(route !== null, 'the main row registered /yukari/api')
  const call = async (url, init) => {
    const res = response()
    await route.handler(request(url, init), res)
    return res
  }
  return { call, route }
}

test('overview: the guarded route reports version and mounted components', async () => {
  const { call } = mount()
  const res = await call('/yukari/api/overview')
  assert.equal(res.statusCode, 200)
  const payload = res.json()
  assert.equal(payload.ok, true)
  assert.match(payload.overview.version, /^\d+\.\d+\.\d+/u)
  assert.equal(typeof payload.overview.components, 'object')
  assert.ok('chats' in payload.overview.components, 'every component key is present, null when off')
  assert.equal(typeof payload.overview.pid, 'number')
  assert.match(payload.overview.bootId, /^[0-9a-f-]{36}$/u, '重启等待按启动标识识别新进程，execve 下 PID 不变')
})

test('overview: HMR re-evaluates the module without changing the process boot id', async () => {
  const before = await (await mount().call('/yukari/api/overview')).json()
  const { apply: reloaded } = await import(`../index.js?hmr-boot-test=${Date.now()}`)
  const after = await (await mount({}, reloaded).call('/yukari/api/overview')).json()
  assert.equal(after.overview.bootId, before.overview.bootId, '插件热重载不是 Host 进程重启')
})

test('icon: served without the connection guard so <img> works', async () => {
  const { call } = mount({ reject: true })
  const res = await call('/yukari/api/icon')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.ok(res.body().length > 1000, 'the PNG has bytes')
})

test('guard: every other action is refused when the connection is not authorised', async () => {
  const { call } = mount({ reject: true })
  const res = await call('/yukari/api/overview')
  assert.equal(res.statusCode, 403)
  assert.equal(res.body().length, 0)
})

test('unknown: an unrecognised action answers 404 with the action name', async () => {
  const { call } = mount()
  const res = await call('/yukari/api/nope')
  assert.equal(res.statusCode, 404)
  assert.match(res.json().error, /nope/u)
})
