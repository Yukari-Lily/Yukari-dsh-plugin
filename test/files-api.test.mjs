import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../host/files/index.js'
import { extractZipArchive } from '../host/browser/lib/zip.js'

/** A response that records what the route wrote. */
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
  stream.body = () => Buffer.concat(chunks)
  stream.json = () => JSON.parse(stream.body().toString('utf8'))
  return stream
}

/** A request whose body is the given JSON. */
function request(url, { method = 'GET', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function mount(root, config = {}) {
  let route = null
  const ctx = {
    webServer: { register: (value) => { route = value } },
    connection: { requestRejection: () => undefined },
    effect: (callback) => { const cleanup = callback(); return () => cleanup?.() },
    logger: { warn: () => {}, info: () => {} },
    get: (name) => (name === 'workspaceRegistry'
      ? { list: () => [{ id: 'ws-1', title: 'Test', path: root, sessionIds: [] }] }
      : undefined),
  }
  apply(ctx, config)
  assert.ok(route !== null, 'the route registers')
  return async (url, options) => {
    const res = response()
    await route.handler(request(url, options), res)
    return res
  }
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yk-files-api-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'readme.md'), '# readme\n')
  await writeFile(path.join(root, 'src', 'app.js'), 'export {}\n')
  return root
}

test('the API lists a workspace and refuses paths outside it', async (t) => {
  const root = await workspace(t)
  const call = await mount(root)

  const roots = (await call('/files/api/roots')).json()
  assert.equal(roots.ok, true)
  assert.equal(roots.roots.length, 1)
  assert.equal(roots.roots[0].path, root)

  const listing = (await call(`/files/api/list?root=${encodeURIComponent(root)}&path=`)).json()
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['src', 'readme.md'])
  assert.equal(listing.entries[0].type, 'dir')
  assert.equal(listing.entries[1].type, 'file')

  const nested = (await call(`/files/api/list?root=${encodeURIComponent(root)}&path=src`)).json()
  assert.deepEqual(nested.entries.map((entry) => entry.name), ['app.js'])

  const escape = await call(`/files/api/list?root=${encodeURIComponent(root)}&path=../`)
  assert.equal(escape.statusCode, 400)
  assert.match(escape.json().error, /climbs outside/u)

  const unknown = await call(`/files/api/list?root=${encodeURIComponent('/etc')}&path=`)
  assert.equal(unknown.statusCode, 400)
  assert.match(unknown.json().error, /unknown workspace root/u)
})

test('a single file downloads with an attachment header', async (t) => {
  const root = await workspace(t)
  const call = await mount(root)
  const res = await call(`/files/api/download?root=${encodeURIComponent(root)}&path=readme.md`)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.match(res.headers['content-disposition'], /readme\.md/u)
  assert.equal(res.body().toString('utf8'), '# readme\n')
})

test('selected folders and files download as one ZIP', async (t) => {
  const root = await workspace(t)
  const call = await mount(root)
  const res = await call('/files/api/archive', { method: 'POST', body: { root, paths: ['src', 'readme.md'] } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/zip')

  const archive = path.join(root, 'download.zip')
  await writeFile(archive, res.body())
  const unpacked = path.join(root, 'unpacked')
  await extractZipArchive(archive, unpacked)
  assert.equal(await readFile(path.join(unpacked, 'readme.md'), 'utf8'), '# readme\n')
  assert.equal(await readFile(path.join(unpacked, 'src', 'app.js'), 'utf8'), 'export {}\n')
})

test('an archive request must select something and stay inside the root', async (t) => {
  const root = await workspace(t)
  const call = await mount(root)
  const empty = await call('/files/api/archive', { method: 'POST', body: { root, paths: [] } })
  assert.equal(empty.statusCode, 400)
  assert.match(empty.json().error, /at least one/u)

  const climb = await call('/files/api/archive', { method: 'POST', body: { root, paths: ['../etc'] } })
  assert.equal(climb.statusCode, 400)
  assert.match(climb.json().error, /climbs outside/u)
})
