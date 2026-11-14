import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { apply, archiveLimitBytes } from '../host/files/index.js'
import { extractZipArchive } from '../host/shared/zip.js'

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
  stream.removeHeader = (name) => { delete stream.headers[name.toLowerCase()] }
  stream.body = () => Buffer.concat(chunks)
  stream.json = () => JSON.parse(stream.body().toString('utf8'))
  return stream
}

/** A request whose body is the given JSON. */
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

/** 让挂住的处理器以失败收场，而不是把整轮测试一起拖住。 */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
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
        if (options.registryMissing === true) return undefined
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
  // cordis throws when a service is read as a bare property without `inject`;
  // the component must reach the registry through ctx.get alone.
  if (options.registryMissing === true) {
    Object.defineProperty(ctx, 'workspaceRegistry', {
      get() {
        throw new Error('cannot get property "workspaceRegistry" without inject')
      },
    })
  }
  apply(ctx, options.config ?? {})
  assert.ok(route !== null, 'the route registers')
  const call = async (url, init, res = response()) => {
    await route.handler(request(url, init), res)
    return res
  }
  call.route = route
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

test('a composition without workspaceRegistry still serves the working directory', async (t) => {
  await workspace(t)
  const call = await mount(process.cwd(), { registryMissing: true })

  const roots = (await call('/files/api/roots')).json()
  assert.equal(roots.ok, true)
  assert.deepEqual(roots.roots.map((entry) => entry.path), [process.cwd()])
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

test('a download serves one byte range and rejects an impossible one', async (t) => {
  const root = await workspace(t)
  const call = await mount(root)
  const url = `/files/api/download?root=${encodeURIComponent(root)}&path=readme.md`

  const full = await call(url)
  assert.equal(full.statusCode, 200)
  assert.equal(full.headers['accept-ranges'], 'bytes')
  assert.match(String(full.headers['etag']), /^"[0-9a-f]+-[0-9a-f]+"$/u)
  assert.equal(Number.isNaN(Date.parse(String(full.headers['last-modified']))), false, 'last-modified is an HTTP date')

  const partial = await call(url, { headers: { range: 'bytes=2-5' } })
  assert.equal(partial.statusCode, 206)
  assert.equal(partial.headers['content-range'], 'bytes 2-5/9')
  assert.equal(partial.headers['content-length'], '4')
  assert.equal(partial.body().toString('utf8'), 'read')

  const suffix = await call(url, { headers: { range: 'bytes=-2' } })
  assert.equal(suffix.statusCode, 206)
  assert.equal(suffix.headers['content-range'], 'bytes 7-8/9')
  assert.equal(suffix.body().toString('utf8'), 'e\n')

  const impossible = await call(url, { headers: { range: 'bytes=99-' } })
  assert.equal(impossible.statusCode, 416)
  assert.equal(impossible.headers['content-range'], 'bytes */9')
  assert.equal(impossible.body().length, 0)
})

test('a non-ASCII file name is offered in both disposition forms', async (t) => {
  const root = await workspace(t)
  await writeFile(path.join(root, '报告.txt'), '正文\n')
  const call = await mount(root)
  const res = await call(`/files/api/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent('报告.txt')}`)
  const disposition = String(res.headers['content-disposition'])
  assert.match(disposition, /^attachment; filename="[^"]+"; filename\*=UTF-8''/u)
  assert.ok(disposition.includes(`filename*=UTF-8''${encodeURIComponent('报告.txt')}`), 'the RFC 5987 form carries the real name')
  assert.equal(disposition.includes('%E6%8A%A5%E5%91%8A%E6%96%87%E4%BB%B6.txt"'), false, 'the ASCII fallback is not percent-encoded')
})

test('an SVG is never returned as an inline document', async (t) => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  const call = await mount(root)

  const inline = await call(`/files/api/download?root=${encodeURIComponent(root)}&path=evil.svg&inline=1`)
  assert.equal(inline.headers['content-type'], 'application/octet-stream')
  assert.equal(inline.headers['x-content-type-options'], 'nosniff')
  assert.equal(inline.headers['content-security-policy'], 'sandbox')

  const attachment = await call(`/files/api/download?root=${encodeURIComponent(root)}&path=readme.md`)
  assert.equal(attachment.headers['x-content-type-options'], 'nosniff')

  const preview = (await call(`/files/api/preview?root=${encodeURIComponent(root)}&path=evil.svg`)).json()
  assert.equal(preview.kind, 'text', 'the SVG source is shown as text and never rendered')
})

test('a download handler settles when the client drops the connection', async (t) => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'big.bin'), Buffer.alloc(8 * 1024 * 1024))
  const call = await mount(root)

  // 第一次写入就断开，模拟浏览器取消下载：旧实现会把源流暂停后永远等 end/close。
  const chunks = []
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      res.destroy()
      callback()
    },
  })
  res.statusCode = 200
  res.headers = {}
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value }
  res.removeHeader = (name) => { delete res.headers[name.toLowerCase()] }

  await withTimeout(
    call.route.handler(request(`/files/api/download?root=${encodeURIComponent(root)}&path=big.bin`), res),
    2000,
    'the download handler',
  )
  assert.equal(res.destroyed, true)
  assert.ok(chunks.length <= 1, 'the handler stops writing once the connection is gone')
})

test('a listing that hits the entry cap says so instead of stopping silently', async (t) => {
  const root = await workspace(t)
  await Promise.all(Array.from({ length: 5001 }, (_item, index) => writeFile(path.join(root, `f${index}.txt`), '')))
  const call = await mount(root)
  const payload = (await call(`/files/api/list?root=${encodeURIComponent(root)}&path=`)).json()
  assert.equal(payload.entries.length, 5000)
  assert.equal(payload.truncated, true)
  assert.equal(payload.limit, 5000, 'the cap travels with the flag so the panel can name it')
})

test('a folder with more than 5000 files still downloads', async (t) => {
  const root = await workspace(t)
  const many = path.join(root, 'many')
  await mkdir(many, { recursive: true })
  await Promise.all(Array.from({ length: 5001 }, (_item, index) => writeFile(path.join(many, `f${index}.txt`), '')))
  const call = await mount(root)
  const res = await call('/files/api/archive', { method: 'POST', body: { root, paths: ['many'] } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/zip')
  // 目录本身一条记录 + 5001 个文件，名字都在中央目录里。
  assert.ok(res.body().includes(Buffer.from('many/f5000.txt')), 'the last file made it into the archive')
})

test('the archive limit is clamped to what a ZIP can address', () => {
  assert.equal(archiveLimitBytes({ maxMb: 99999 }), 4096 * 1048576)
  assert.equal(archiveLimitBytes({ maxMb: 8 }), 8 * 1048576)
  assert.equal(archiveLimitBytes({}), 4096 * 1048576)
})

test('the archive route honours the configured byte limit', async (t) => {
  const root = await workspace(t)
  await writeFile(path.join(root, 'big.bin'), Buffer.alloc(2 * 1024 * 1024))
  const call = await mount(root, { config: { maxMb: 1 } })
  const res = await call('/files/api/archive', { method: 'POST', body: { root, paths: ['big.bin'] } })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /上限/u)
})
