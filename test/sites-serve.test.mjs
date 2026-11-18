/**
 * `/p` 的静态应答：默认本地部署没有别的静态服务器，宿主自己提供发布根，
 * 发出来的链接才点得开。这里用真实临时目录走一遍处理器，覆盖目录跳转、
 * 类型、越界与隐藏文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { apply, SITE_PATH } from '../host/sites/index.js'

/** Collect everything written to a fake response. */
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
  stream.text = () => Buffer.concat(chunks).toString('utf8')
  stream.bytes = () => Buffer.concat(chunks)
  return stream
}

async function mount(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'yk-site-serve-'))
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  const root = path.join(temporary, 'publish')
  const outside = path.join(temporary, 'outside.txt')
  await writeFile(outside, 'secret')
  await mkdir(path.join(root, 'demo'), { recursive: true })
  await writeFile(path.join(root, 'demo', 'index.html'), '<h1>demo</h1>')
  await writeFile(path.join(root, 'demo', 'app.js'), 'console.log(1)')
  await writeFile(path.join(root, 'demo', 'blob.bin'), Buffer.from([0, 1, 2]))
  await writeFile(path.join(root, 'demo', '.env'), 'TOKEN=1')
  await symlink(outside, path.join(root, 'demo', 'leak.txt'))
  await mkdir(path.join(root, 'Some Dir'), { recursive: true })
  await writeFile(path.join(root, 'Some Dir', 'index.html'), 'x')

  const routes = new Map()
  const ctx = {
    tools: { register: () => {} },
    webServer: { register: (value) => { routes.set(value.path, value); return () => {} } },
    connection: { requestRejection: () => undefined },
    effect: (callback) => { const cleanup = callback(); return () => cleanup?.() },
    logger: { warn: () => {}, info: () => {} },
    get: () => undefined,
  }
  apply(ctx, { root, stateRoot: path.join(temporary, 'state'), maxMb: 8, maxFiles: 100 })
  const handler = routes.get(SITE_PATH)?.handler
  assert.equal(typeof handler, 'function', 'the publish root route is registered')
  const call = async (target, method = 'GET') => {
    const res = response()
    await handler({ url: target, method, headers: {} }, res)
    return res
  }
  return { call, root }
}

test('serve: a directory URL answers its index.html', async (t) => {
  const { call } = await mount(t)
  const res = await call('/p/demo/')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-cache')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['content-length'], String(Buffer.byteLength('<h1>demo</h1>')))
  assert.equal(res.text(), '<h1>demo</h1>')
})

test('serve: assets keep their type and unknown suffixes stay binary', async (t) => {
  const { call } = await mount(t)
  const script = await call('/p/demo/app.js')
  assert.equal(script.statusCode, 200)
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(script.text(), 'console.log(1)')

  const blob = await call('/p/demo/blob.bin')
  assert.equal(blob.statusCode, 200)
  assert.equal(blob.headers['content-type'], 'application/octet-stream')
  assert.deepEqual([...blob.bytes()], [0, 1, 2])
})

test('serve: HEAD answers the headers without a body', async (t) => {
  const { call } = await mount(t)
  const res = await call('/p/demo/index.html', 'HEAD')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-length'], String(Buffer.byteLength('<h1>demo</h1>')))
  assert.equal(res.text(), '')
})

test('serve: a directory URL without the trailing slash redirects to it', async (t) => {
  const { call } = await mount(t)
  const res = await call('/p/demo')
  assert.equal(res.statusCode, 301)
  assert.equal(res.headers.location, '/p/demo/')
})

test('serve: missing paths, the mount root and other methods are refused', async (t) => {
  const { call } = await mount(t)
  assert.equal((await call('/p/')).statusCode, 404)
  assert.equal((await call('/p/nope/')).statusCode, 404)
  assert.equal((await call('/p/demo/nope.html')).statusCode, 404)
  const post = await call('/p/demo/', 'POST')
  assert.equal(post.statusCode, 405)
  assert.equal(post.headers.allow, 'GET, HEAD')
})

test('serve: traversal cannot leave the publish root', async (t) => {
  const { call } = await mount(t)
  assert.equal((await call('/p/%2e%2e/outside.txt')).statusCode, 404, 'an encoded dot segment is refused')
  assert.equal((await call('/p/demo/%5c..%5coutside.txt')).statusCode, 404, 'backslashes never separate on win32 either')
  assert.equal((await call('/p/demo%2F..%2F..%2Foutside.txt')).statusCode, 404, 'an encoded slash is refused')
  assert.equal((await call('/p/demo/%E0%A4%A')).statusCode, 400, 'a malformed escape is a bad request')
})

test('serve: hidden names and files outside the root never arrive', async (t) => {
  const { call } = await mount(t)
  assert.equal((await call('/p/demo/.env')).statusCode, 404, 'dot files are not served')
  assert.equal((await call('/p/Some%20Dir/')).statusCode, 404, 'a directory that is not a valid slug is not served')
  const leak = await call('/p/demo/leak.txt')
  assert.equal(leak.statusCode, 403, 'a symlink pointing outside the root is refused')
  assert.equal(leak.text(), '')
})
