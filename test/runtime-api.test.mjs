/**
 * /dshctl/api 的路由层：只碰不启动进程的分支（dry-run、404、405、连接栅栏）。
 *
 * `state` 会去问 npm 的全局前缀，`update` 会真的装包，所以那两条留给手工验证；
 * 这里覆盖的是"面板发错请求"与"没被授权"时会发生什么。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, preflightUpgrade } from '../host/runtime/index.js'

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

function mount(options = {}) {
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
  apply(ctx, { restartMode: 'exit', restartDelayMs: 0 })
  assert.ok(route !== null, 'the component registered a route')
  const call = async (url, init) => {
    const res = response()
    await route.handler(request(url, init), res)
    return res
  }
  return { call, tools }
}

test('restart: a dry run reports the plan without scheduling anything', async () => {
  const { call } = mount()
  const res = await call('/dshctl/api/restart', { method: 'POST', body: { dryRun: true } })
  assert.equal(res.statusCode, 202, 'the route answers 202 even for a planned-only request')
  const payload = res.json()
  assert.equal(payload.scheduled, false)
  assert.equal(payload.dryRun, true)
  assert.equal(typeof payload.strategy, 'string')
})

test('methods and actions: wrong verb is 405, unknown action is 404', async () => {
  const { call } = mount()
  assert.equal((await call('/dshctl/api/restart')).statusCode, 405)
  assert.equal((await call('/dshctl/api/nope', { method: 'POST', body: {} })).statusCode, 404)
})

test('guard: a rejected connection never reaches the handler', async () => {
  const { call } = mount({ reject: true })
  const res = await call('/dshctl/api/state')
  assert.equal(res.statusCode, 403)
  assert.equal(res.json(), null)
})

test('tools: every runtime tool is registered with an output schema', () => {
  const { tools } = mount()
  const names = tools.map((tool) => tool.name)
  for (const name of ['dsh_runtime_status', 'dsh_check_update', 'dsh_update', 'dsh_restart']) {
    assert.ok(names.includes(name), `${name} is registered`)
  }
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.output?.schema, `${tool.name} declares an output schema`)
  }
})

test('preflight: a copy outside the npm prefix is refused, because the install would not replace it', () => {
  const refusal = preflightUpgrade({
    runningDir: '/workspace/deepseek-harness/apps/cli',
    globalRoot: '/data/.npm-global/lib/node_modules',
    nodeVersion: '24.22.2',
    engines: { node: '>=24.9.0' },
  })
  assert.match(refusal, /不在 npm 全局前缀/u)
})

test('preflight: the running copy inside the prefix passes and keeps a sibling prefix apart', () => {
  assert.equal(preflightUpgrade({
    runningDir: '/data/.npm-global/lib/node_modules/@deepseek-ai/dsh',
    globalRoot: '/data/.npm-global/lib/node_modules',
    nodeVersion: '24.22.2',
    engines: { node: '>=24.9.0' },
  }), null)
  // 前缀前缀不算命中：/x/node_modules-old 不是 /x/node_modules。
  assert.match(preflightUpgrade({
    runningDir: '/data/node_modules-old/@deepseek-ai/dsh',
    globalRoot: '/data/node_modules',
    nodeVersion: '24.22.2',
    engines: null,
  }), /不在 npm 全局前缀/u)
})

test('preflight: a release that needs a newer Node is refused before anything installs', () => {
  const refusal = preflightUpgrade({
    runningDir: '/data/.npm-global/lib/node_modules/@deepseek-ai/dsh',
    globalRoot: '/data/.npm-global/lib/node_modules',
    nodeVersion: '24.22.2',
    engines: { node: '>=25.0.0' },
  })
  assert.match(refusal, /要求 Node >=25\.0\.0/u)
  assert.match(refusal, /当前是 24\.22\.2/u)
})

test('preflight: unknown engines do not block an upgrade', () => {
  assert.equal(preflightUpgrade({
    runningDir: '/data/.npm-global/lib/node_modules/@deepseek-ai/dsh',
    globalRoot: '/data/.npm-global/lib/node_modules',
    nodeVersion: '24.22.2',
    engines: null,
  }), null)
  assert.equal(preflightUpgrade({
    runningDir: null,
    globalRoot: null,
    nodeVersion: '24.22.2',
    engines: undefined,
  }), null)
})
