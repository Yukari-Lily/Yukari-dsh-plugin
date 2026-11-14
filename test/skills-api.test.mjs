/**
 * `/skills/api` 的接口用例。
 *
 * 每条用例都挂到临时 `$DSH_HOME` 上跑：路由、错误信封、附件头与启停搬迁都是
 * 真的走一遍，不直接调库函数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { API_PATH, apply } from '../host/skills/index.js'
import { extractZipArchive } from '../host/shared/zip.js'
import { zipBuffer } from './zip-fixture.mjs'

const SKILL = (name, description = 'A test skill.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

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

/** A request whose body is either JSON or raw bytes. */
function request(url, { method = 'GET', body, raw } = {}) {
  const chunks = raw !== undefined ? [raw] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    url,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Mount the component against a throwaway harness home. */
async function withMount(options, run) {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(path.join(os.tmpdir(), 'yukari-skills-api-'))
  process.env.DSH_HOME = home
  let route = null
  const ctx = {
    webServer: { register: (value) => { route = value; return () => {} } },
    connection: { requestRejection: () => (options.reject === true ? 403 : undefined) },
    effect: (callback) => { const cleanup = callback(); return () => cleanup?.() },
    logger: { warn: () => {}, info: () => {} },
    get: () => undefined,
  }
  apply(ctx)
  assert.ok(route !== null, 'the component registered its prefix route')
  const call = async (url, init) => {
    const res = response()
    await route.handler(request(`${API_PATH}${url}`, init), res)
    return res
  }
  try {
    await run({ home, call })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('state: an empty library reports both roots and no items', async () => {
  await withMount({}, async ({ home, call }) => {
    const res = await call('/state')
    assert.equal(res.statusCode, 200)
    const payload = res.json()
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.items, [])
    assert.equal(payload.root, path.join(home, 'skills'))
    assert.equal(payload.disabledRoot, path.join(home, 'skills-disabled'))
    assert.equal(payload.limits.uploadMb, 16)
    assert.equal(payload.limits.textKb, 256)
  })
})

test('upload: a flat .md is installed and listed at once', async () => {
  await withMount({}, async ({ home, call }) => {
    const res = await call('/upload?filename=demo.md', { method: 'POST', raw: Buffer.from(SKILL('demo-skill')) })
    assert.equal(res.statusCode, 200)
    const payload = res.json()
    assert.equal(payload.item.key, 'demo-skill')
    assert.equal(payload.item.state, 'enabled')

    const list = (await call('/state')).json()
    assert.deepEqual(list.items.map((item) => item.key), ['demo-skill'])
    assert.equal(list.items[0].description, 'A test skill.')
    assert.deepEqual(await readdir(path.join(home, 'skills')), ['demo-skill.md'])
  })
})

test('upload: a zip installs a bundle the download route can hand back', async () => {
  await withMount({}, async ({ call }) => {
    const archive = zipBuffer([
      { name: 'bundle-skill/SKILL.md', data: SKILL('bundle-skill') },
      { name: 'bundle-skill/references/note.md', data: 'reference\n' },
    ])
    const uploaded = await call('/upload?filename=bundle-skill.zip', { method: 'POST', raw: archive })
    assert.equal(uploaded.statusCode, 200)
    assert.equal(uploaded.json().item.form, 'bundle')

    const downloaded = await call('/download?key=bundle-skill&form=bundle')
    assert.equal(downloaded.statusCode, 200)
    assert.equal(downloaded.headers['content-type'], 'application/zip')
    assert.match(downloaded.headers['content-disposition'], /filename\*=UTF-8''bundle-skill\.zip/u)

    const target = await mkdtemp(path.join(os.tmpdir(), 'yukari-skills-roundtrip-'))
    try {
      const zipPath = path.join(target, 'bundle.zip')
      await writeFile(zipPath, downloaded.body())
      const out = path.join(target, 'out')
      await extractZipArchive(zipPath, out)
      assert.deepEqual((await readdir(out, { recursive: true })).sort(), [
        'bundle-skill',
        path.join('bundle-skill', 'SKILL.md'),
        path.join('bundle-skill', 'references'),
        path.join('bundle-skill', 'references', 'note.md'),
      ].sort())
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })
})

test('upload: a rejected filename answers with a code the panel can show', async () => {
  await withMount({}, async ({ call }) => {
    const res = await call('/upload?filename=skill.tar.gz', { method: 'POST', raw: Buffer.from('x') })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().ok, false)
    assert.equal(res.json().code, 'skill-kind-unknown')
  })
})

test('skill + save: the editor reads and rewrites one body', async () => {
  await withMount({}, async ({ home, call }) => {
    await call('/upload?filename=demo.md', { method: 'POST', raw: Buffer.from(SKILL('demo-skill')) })

    const read = await call('/skill?key=demo-skill&form=file')
    assert.equal(read.statusCode, 200)
    assert.equal(read.json().text, SKILL('demo-skill'))
    assert.equal(read.json().truncated, false)

    const saved = await call('/save', { method: 'POST', body: { key: 'demo-skill', form: 'file', text: SKILL('demo-skill', 'Rewritten.') } })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().item.description, 'Rewritten.')

    const broken = await call('/save', { method: 'POST', body: { key: 'demo-skill', form: 'file', text: '# no frontmatter' } })
    assert.equal(broken.statusCode, 400)
    assert.equal(broken.json().code, 'skill-invalid')
    assert.equal(broken.json().params.problem, 'no-frontmatter')
    assert.equal(await readFileText(path.join(home, 'skills', 'demo-skill.md')), SKILL('demo-skill', 'Rewritten.'))
  })
})

/** Read a file as text without importing fs/promises twice. */
async function readFileText(file) {
  const { readFile } = await import('node:fs/promises')
  return readFile(file, 'utf8')
}

test('disable and enable: the state and the two directories agree', async () => {
  await withMount({}, async ({ home, call }) => {
    await call('/upload?filename=demo.md', { method: 'POST', raw: Buffer.from(SKILL('demo-skill')) })

    const off = await call('/disable', { method: 'POST', body: { key: 'demo-skill', form: 'file' } })
    assert.equal(off.statusCode, 200)
    assert.equal(off.json().item.state, 'disabled')
    assert.deepEqual(await readdir(path.join(home, 'skills')), [])
    assert.deepEqual(await readdir(path.join(home, 'skills-disabled')), ['demo-skill.md'])
    assert.equal((await call('/state')).json().items[0].state, 'disabled')

    const on = await call('/enable', { method: 'POST', body: { key: 'demo-skill', form: 'file' } })
    assert.equal(on.statusCode, 200)
    assert.equal(on.json().item.state, 'enabled')
    assert.deepEqual(await readdir(path.join(home, 'skills-disabled')), [])
  })
})

test('delete: the entry disappears from both directories', async () => {
  await withMount({}, async ({ home, call }) => {
    await call('/upload?filename=demo.md', { method: 'POST', raw: Buffer.from(SKILL('demo-skill')) })
    const removed = await call('/delete', { method: 'POST', body: { key: 'demo-skill', form: 'file' } })
    assert.equal(removed.statusCode, 200)
    assert.equal(removed.json().key, 'demo-skill')
    assert.deepEqual(await readdir(path.join(home, 'skills')), [])

    const again = await call('/delete', { method: 'POST', body: { key: 'demo-skill', form: 'file' } })
    assert.equal(again.statusCode, 404)
    assert.equal(again.json().code, 'skill-not-found')
  })
})

test('keys: a path cannot climb out of the library', async () => {
  await withMount({}, async ({ call }) => {
    for (const key of ['..', '../escape', 'a/b', '.hidden']) {
      const res = await call(`/skill?key=${encodeURIComponent(key)}&form=file`)
      assert.equal(res.statusCode, 400, `expected ${key} to be refused`)
      assert.equal(res.json().code, 'skill-key-invalid')
    }
    const form = await call('/skill?key=demo&form=tar')
    assert.equal(form.json().code, 'skill-form-invalid')
  })
})

test('guard: an unauthorised connection reaches no handler', async () => {
  await withMount({ reject: true }, async ({ call }) => {
    for (const url of ['/state', '/skill?key=demo&form=file']) {
      const res = await call(url)
      assert.equal(res.statusCode, 403)
      assert.equal(res.body().length, 0)
    }
  })
})

test('dispatch: an unknown action answers 404 with the verb it saw', async () => {
  await withMount({}, async ({ call }) => {
    const res = await call('/not-a-thing')
    assert.equal(res.statusCode, 404)
    assert.match(res.json().error, /GET/u)
  })
})
