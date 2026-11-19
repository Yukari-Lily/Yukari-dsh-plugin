/**
 * /publish/api 的路由层：`list` / `settings` / `delete` 的分派、方法限制与
 * 前缀校验。组件自己的 store 测试只覆盖发布/回收逻辑，这里补的是"面板真的
 * 发一个请求会发生什么"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { apply, API_PATH, DEFAULT_SITE_PATH } from '../host/sites/index.js'

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
  const routes = new Map()
  const tools = []
  const setups = []
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: {
      // 与宿主一致：同名路由是硬冲突，disposer 把它摘掉。
      register: (value) => {
        if (routes.has(value.path)) throw new Error(`webserver: duplicate prefix route "${value.path}"`)
        routes.set(value.path, value)
        return () => { routes.delete(value.path) }
      },
      ...(options.noOrigin
        ? {}
        : { host: '127.0.0.1', port: 3080, protocol: 'http:', getOrigin: () => 'http://127.0.0.1:3080' }),
    },
    connection: { requestRejection: options.reject ? () => 403 : () => undefined },
    // 挂载发布根是异步 effect：等它跑完，路由表才反映真实状态。
    effect: (callback) => { setups.push(Promise.resolve(callback())); return () => {} },
    logger: { warn: () => {}, info: () => {} },
    get: () => undefined,
  }
  apply(ctx, {
    root: path.join(root, 'publish'),
    stateRoot: path.join(root, 'state'),
    maxMb: 8,
    maxFiles: 100,
  })
  await Promise.all(setups)
  const api = routes.get(API_PATH)
  assert.ok(api?.handler !== undefined, 'the component registered the API route')
  assert.equal(typeof routes.get(DEFAULT_SITE_PATH)?.handler, 'function', 'the publish root is served by the host')
  const call = async (url, init) => {
    const res = response()
    await api.handler(request(url, init), res)
    return { status: res.statusCode, json: res.json(), headers: res.headers }
  }
  const savedPath = async () => {
    const file = path.join(root, 'state', 'settings.json')
    const text = await readFile(file, 'utf8').catch(() => null)
    return text === null ? null : JSON.parse(text).path
  }
  return { call, tools, root, routes, savedPath }
}

test('list: the route answers with sites, root and the active path', async (t) => {
  const { call } = await mount(t)
  const result = await call('/publish/api/list')
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.sites, [])
  assert.equal(result.json.sitePath, '/p', 'the row config names no path')
  assert.equal(result.json.defaultPath, '/p')
  assert.equal(result.json.customSitePath, false)
  assert.equal(result.json.pathFallback, null)
  assert.equal(result.json.localBase, 'http://127.0.0.1:3080', 'the panel can open links on the address it is reached at')
  assert.equal(result.json.adoptedFrom, null, 'an explicit root is never overridden by the legacy scan')
})

test('list: an unbound listener leaves no absolute base behind', async (t) => {
  const { call } = await mount(t, { noOrigin: true })
  const result = await call('/publish/api/list')
  assert.equal(result.status, 200)
  assert.equal(result.json.localBase, null, 'without an origin the panel keeps the relative path')
})

test('settings: saving a path moves the publish root right away', async (t) => {
  const { call, routes, savedPath } = await mount(t)
  const result = await call('/publish/api/settings', { method: 'POST', body: { path: '/sites' } })
  assert.equal(result.status, 200)
  assert.equal(result.json.sitePath, '/sites')
  assert.equal(result.json.customSitePath, true)
  assert.deepEqual([...routes.keys()].sort(), [API_PATH, '/sites'].sort(), 'the old route is gone, the new one answers')
  assert.equal(await savedPath(), '/sites', 'the path is persisted for the next boot')

  const restored = await call('/publish/api/settings', { method: 'POST', body: { path: '/sites' } })
  assert.equal(restored.status, 200, 'saving the same path twice must not collide with its own route')
  assert.equal(await savedPath(), '/sites')
})

test('settings: the listed URL follows the path without republishing', async (t) => {
  const { call, root } = await mount(t)
  await mkdir(path.join(root, 'publish', 'demo'), { recursive: true })
  await writeFile(path.join(root, 'publish', 'demo', 'index.html'), '<title>Demo</title>')
  const before = await call('/publish/api/list')
  assert.equal(before.json.sites[0].url, '/p/demo/')
  const saved = await call('/publish/api/settings', { method: 'POST', body: { path: '/sites' } })
  assert.equal(saved.json.sites[0].url, '/sites/demo/', 'a published site keeps its directory, only the prefix moves')
})

test('settings: a path without the leading slash is refused with its own code', async (t) => {
  const { call, routes, savedPath } = await mount(t)
  const result = await call('/publish/api/settings', { method: 'POST', body: { path: 'sites' } })
  assert.equal(result.status, 400)
  assert.equal(result.json.code, 'path-invalid', 'the panel can localize this failure')
  assert.match(result.json.error, /以 \/ 开头/u)
  assert.deepEqual([...routes.keys()].sort(), [API_PATH, '/p'].sort(), 'a refused path never touches the live route')
  assert.equal(await savedPath(), null)
})

test('settings: a reserved path is refused with its own code', async (t) => {
  const { call } = await mount(t)
  for (const value of ['/', '/api', '/plugins', '/publish/api']) {
    const result = await call('/publish/api/settings', { method: 'POST', body: { path: value } })
    assert.equal(result.status, 400, value)
    assert.equal(result.json.code, 'path-reserved', value)
  }
})

test('settings: a path another route already answers is refused and the old one stays', async (t) => {
  const { call, routes, savedPath } = await mount(t)
  routes.set('/taken', { kind: 'prefix', path: '/taken', handler: () => {} })
  const result = await call('/publish/api/settings', { method: 'POST', body: { path: '/taken' } })
  assert.equal(result.status, 400)
  assert.equal(result.json.code, 'path-taken', 'the panel can localize this failure')
  assert.equal(typeof routes.get('/p')?.handler, 'function', 'the publish root came back on the old path')
  assert.equal(await savedPath(), null, 'nothing was persisted for the refused path')
})

test('settings: clearing the field goes back to the row config', async (t) => {
  const { call, routes } = await mount(t)
  await call('/publish/api/settings', { method: 'POST', body: { path: '/sites' } })
  const result = await call('/publish/api/settings', { method: 'POST', body: { path: '' } })
  assert.equal(result.status, 200)
  assert.equal(result.json.sitePath, '/p')
  assert.equal(result.json.customSitePath, false)
  assert.deepEqual([...routes.keys()].sort(), [API_PATH, '/p'].sort())
})

test('settings: a saved path that is already taken at boot falls back to the default', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yk-sites-boot-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  await mkdir(path.join(root, 'state', 'sites'), { recursive: true })
  await writeFile(path.join(root, 'state', 'settings.json'), JSON.stringify({ path: '/taken' }))
  const routes = new Map([['/taken', { kind: 'prefix', path: '/taken', handler: () => {} }]])
  const setups = []
  const warnings = []
  const ctx = {
    tools: { register: () => {} },
    webServer: {
      register: (value) => {
        if (routes.has(value.path)) throw new Error(`webserver: duplicate prefix route "${value.path}"`)
        routes.set(value.path, value)
        return () => { routes.delete(value.path) }
      },
    },
    connection: { requestRejection: () => undefined },
    effect: (callback) => { setups.push(Promise.resolve(callback())); return () => {} },
    logger: { warn: (message) => warnings.push(message), info: () => {} },
    get: () => undefined,
  }
  apply(ctx, { root: path.join(root, 'publish'), stateRoot: path.join(root, 'state') })
  await Promise.all(setups)
  assert.equal(typeof routes.get('/p')?.handler, 'function', 'the component still serves the publish root somewhere')
  assert.equal(routes.get('/taken')?.handler !== undefined, true, 'the other route keeps its path')
  assert.equal(warnings.some((line) => line.includes('/taken')), true, 'the fallback is reported to the log')

  // 面板要能把这个状态清掉：内存里已经没有自定义值，盘上还留着挂不上的路径。
  const res = response()
  const body = Buffer.from(JSON.stringify({ path: '' }))
  await routes.get(API_PATH).handler(
    {
      url: `${API_PATH}/settings`,
      method: 'POST',
      headers: {},
      async *[Symbol.asyncIterator]() { yield body },
    },
    res,
  )
  assert.equal(res.statusCode, 200)
  const payload = res.json()
  assert.equal(payload.pathFallback, null, 'clearing the field drops the fallback note')
  assert.equal(payload.sitePath, '/p')
  assert.equal(JSON.parse(await readFile(path.join(root, 'state', 'settings.json'), 'utf8')).path, '', 'the unusable path is cleared from disk')
})

test('publish: the result carries the address the Host itself answers on', async (t) => {
  // 反代带认证时公网地址对智能体不可达；返回宿主自己的来源，验证不用去猜端口。
  const { tools, root } = await mount(t)
  const source = path.join(root, 'src')
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, 'index.html'), '<title>Demo</title>')
  const publish = tools.find((tool) => tool.name === 'publish_site')
  const listed = tools.find((tool) => tool.name === 'list_sites')
  const result = await publish.execute({ source, slug: 'demo' })
  assert.equal(result.url, '/p/demo/')
  assert.equal(result.verifyUrl, 'http://127.0.0.1:3080/p/demo/', 'the local address is exact, not guessed')
  const sites = await listed.execute({})
  assert.equal(sites.root, path.join(root, 'publish'), 'the listing names the publish root')
  assert.deepEqual(sites.sites.map((site) => site.slug), ['demo'])
})

test('publish: an unbound listener leaves verifyUrl out instead of inventing one', async (t) => {
  const { tools, root } = await mount(t, { noOrigin: true })
  const source = path.join(root, 'src')
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, 'index.html'), '<title>Demo</title>')
  const result = await tools.find((tool) => tool.name === 'publish_site').execute({ source, slug: 'demo' })
  assert.equal(result.url, '/p/demo/')
  assert.equal('verifyUrl' in result, false)
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
