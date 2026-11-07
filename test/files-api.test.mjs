import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

async function mount(root, options = {}) {
  let route = null
  const counters = { registry: 0, sessions: 0 }
  const ctx = {
    webServer: { register: (value) => { route = value } },
    connection: { requestRejection: () => undefined },
    effect: (callback) => { const cleanup = callback(); return () => cleanup?.() },
    logger: { warn: () => {}, info: () => {} },
    get: (name) => {
      if (name === 'workspaceRegistry') {
        return {
          list: () => {
            counters.registry += 1
            return [{ id: 'ws-1', title: 'Test', path: root, sessionIds: [] }]
          },
        }
      }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => {
            counters.sessions += 1
            return options.sessions ?? []
          },
        }
      }
      return undefined
    },
  }
  apply(ctx, options.config ?? {})
  assert.ok(route !== null, 'the route registers')
  const call = async (url, init) => {
    const res = response()
    await route.handler(request(url, init), res)
    return res
  }
  call.counters = counters
  return call
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
  assert.match(escape.json().error, /超出工作区/u)

  const unknown = await call(`/files/api/list?root=${encodeURIComponent('/etc')}&path=`)
  assert.equal(unknown.statusCode, 400)
  assert.match(unknown.json().error, /未知工作区/u)
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
  assert.match(empty.json().error, /至少选择一个/u)

  const climb = await call('/files/api/archive', { method: 'POST', body: { root, paths: ['../etc'] } })
  assert.equal(climb.statusCode, 400)
  assert.match(climb.json().error, /超出工作区/u)
})

test('listing never scans the session index, and roots are cached', async (t) => {
  const root = await workspace(t)
  const call = await mount(root)
  await call(`/files/api/roots`)
  await call(`/files/api/roots`)
  await call(`/files/api/list?root=${encodeURIComponent(root)}&path=`)
  assert.equal(call.counters.registry, 1, 'the cached root list is reused')
  assert.equal(call.counters.sessions, 0, 'a directory listing does not touch the session index')
})

test('preview returns the text of a small file', async (t) => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'README.md'), '# 标题\n正文\n')
  const call = await mount(root)
  const res = await call(`/files/api/preview?root=${encodeURIComponent(root)}&path=README.md`)
  assert.equal(res.statusCode, 200)
  const payload = res.json()
  assert.equal(payload.kind, 'text')
  assert.match(payload.text, /标题/)
  assert.equal(payload.truncated, false)
})

test('preview truncates a large file instead of reading all of it', async (t) => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'big.txt'), 'x'.repeat(600 * 1024))
  const call = await mount(root)
  const payload = (await call(`/files/api/preview?root=${encodeURIComponent(root)}&path=big.txt`)).json()
  assert.equal(payload.kind, 'text')
  assert.equal(payload.truncated, true)
  assert.ok(payload.text.length <= 512 * 1024, 'the body stays inside the preview budget')
})

test('preview reports a binary file without returning its bytes', async (t) => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'report.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]))
  const call = await mount(root)
  const payload = (await call(`/files/api/preview?root=${encodeURIComponent(root)}&path=report.pdf`)).json()
  assert.equal(payload.kind, 'binary')
  assert.equal(payload.text, undefined)
})

test('preview names an image by type so the panel can load it inline', async (t) => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const call = await mount(root)
  const payload = (await call(`/files/api/preview?root=${encodeURIComponent(root)}&path=logo.png`)).json()
  assert.equal(payload.kind, 'image')
  assert.equal(payload.mime, 'image/png')
})

test('preview refuses a path that leaves the workspace', async (t) => {
  const root = await workspace(t)
  const call = await mount(root)
  const res = await call(`/files/api/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent('../outside.txt')}`)
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().ok, false)
})

test('an inline download carries the real type and no attachment header', async (t) => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const call = await mount(root)
  const res = await call(`/files/api/download?root=${encodeURIComponent(root)}&path=logo.png&inline=1`)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(res.headers['content-disposition'], undefined)
})

test('a plain download still asks the browser to save the file', async (t) => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const call = await mount(root)
  const res = await call(`/files/api/download?root=${encodeURIComponent(root)}&path=logo.png`)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.match(String(res.headers['content-disposition']), /^attachment;/)
})
