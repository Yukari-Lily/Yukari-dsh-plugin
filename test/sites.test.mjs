import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SiteStore } from '../host/sites/lib/sites.js'
import { apply } from '../host/sites/index.js'

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'yukari-sites-'))
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(temporary, { recursive: true, force: true })))
  const root = path.join(temporary, 'publish')
  const store = new SiteStore({ root, stateRoot: path.join(temporary, 'state') })
  const source = path.join(temporary, 'source')
  await mkdir(source)
  await writeFile(path.join(source, 'index.html'), '<title>Example</title>')
  return { temporary, root, store, source }
}

async function emptyStaging(store) {
  assert.deepEqual(await readdir(store.stagingDir), [])
}

test('publish rejects symlinks before creating a stage', async (t) => {
  const { temporary, store, source } = await fixture(t)
  await symlink(path.join(temporary, 'outside'), path.join(source, 'linked'))
  await assert.rejects(store.publish({ source, slug: 'safe' }), /不允许符号链接/)
  assert.equal(await store.list().then((sites) => sites.length), 0)
  await emptyStaging(store)
  await assert.rejects(store.publish({ source: path.join(source, 'linked'), slug: 'safe' }), /符号链接|不存在/)
})

test('publish rejects source and publish state overlap', async (t) => {
  const { store, root } = await fixture(t)
  await assert.rejects(store.publish({ source: root, slug: 'recursive' }), /发布目录或状态目录/)
  await emptyStaging(store)
})

test('publish enforces the file-count limit without leaking staging', async (t) => {
  const { store, source } = await fixture(t)
  store.maxFiles = 1
  await writeFile(path.join(source, 'extra.txt'), 'extra')
  await assert.rejects(store.publish({ source, slug: 'limited' }), /文件数超过 1 个/)
  await emptyStaging(store)
})

test('publish cleans staging when validation fails after copying', async (t) => {
  const { store, source } = await fixture(t)
  await writeFile(path.join(source, 'index.html'), '<script src="/absolute.js"></script>')
  await assert.rejects(store.publish({ source, slug: 'invalid' }), /根路径资源引用/)
  await emptyStaging(store)
})

test('manifest failure restores the old site and its manifest', async (t) => {
  const { store, source, root } = await fixture(t)
  await store.publish({ source, slug: 'rollback' })
  await writeFile(path.join(source, 'index.html'), '<title>Replacement</title>')
  const originalWrite = store.writeManifest.bind(store)
  store.writeManifest = async () => { throw new Error('manifest failed') }
  await assert.rejects(store.publish({ source, slug: 'rollback' }), /manifest failed/)
  store.writeManifest = originalWrite
  assert.equal(await readFile(path.join(root, 'rollback', 'index.html'), 'utf8'), '<title>Example</title>')
  const [site] = await store.list()
  assert.equal(site.title, 'Example')
  assert.equal(site.version, 1)
  assert.equal(site.files, 1)
  await emptyStaging(store)
})

test('list_sites schema includes every returned file and version field', () => {
  const tools = []
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    effect: () => {},
    webServer: { register: () => () => {} },
    connection: { requestRejection: () => null },
  }
  apply(ctx, {})
  const schema = tools.find((tool) => tool.name === 'list_sites').output.schema.properties.sites.items
  for (const field of ['files', 'version']) {
    assert.ok(schema.properties[field])
    assert.ok(schema.required.includes(field))
  }
})

test('publish skips secrets and build junk instead of serving them', async (t) => {
  const { store, source, root } = await fixture(t)
  await mkdir(path.join(source, '.git'))
  await writeFile(path.join(source, '.git', 'config'), '[core]')
  await writeFile(path.join(source, '.env'), 'TOKEN=1')
  await writeFile(path.join(source, 'server.pem'), 'key')
  const record = await store.publish({ source, slug: 'clean' })
  assert.equal(record.skipped, 3)
  assert.deepEqual((await readdir(path.join(root, 'clean'))).sort(), ['index.html'])
})

test('publish removes real source maps but keeps unrelated .map files', async (t) => {
  const { store, source, root } = await fixture(t)
  await writeFile(path.join(source, 'app.js'), 'console.log(1)')
  await writeFile(path.join(source, 'app.js.map'), '{}')
  await writeFile(path.join(source, 'district.map'), '{}')
  await store.publish({ source, slug: 'maps' })
  assert.deepEqual((await readdir(path.join(root, 'maps'))).sort(), ['app.js', 'district.map', 'index.html'])
})

test('setPublicBase refuses the panel origin and non-public hosts', async (t) => {
  const { store } = await fixture(t)
  await assert.rejects(store.setPublicBase('https://dsh.example.com/p', { panelHost: 'dsh.example.com' }), /与面板同源/)
  await assert.rejects(store.setPublicBase('http://127.0.0.1:3080/p'), /回环/)
  await assert.rejects(store.setPublicBase('http://169.254.169.254/p'), /链路本地/)
  await assert.rejects(store.setPublicBase('ftp://pages.example.com'), /http 与 https/)
  const base = await store.setPublicBase('https://pages.example.com', { panelHost: 'dsh.example.com:3080' })
  assert.equal(base, 'https://pages.example.com')
  assert.equal(await store.setPublicBase(''), store.defaultPublicBase)
})

test('two publishes of one slug are serialized instead of merging', async (t) => {
  const { store, source } = await fixture(t)
  await writeFile(path.join(source, 'a.txt'), 'a')
  const [first, second] = await Promise.all([
    store.publish({ source, slug: 'race' }),
    store.publish({ source, slug: 'race' }),
  ])
  assert.deepEqual([first.version, second.version], [1, 2])
  await emptyStaging(store)
})

test('list ignores directories whose names are not valid slugs', async (t) => {
  const { store, root } = await fixture(t)
  await store.init()
  await mkdir(path.join(root, 'Some Dir'))
  await mkdir(path.join(root, 'valid-slug'))
  assert.deepEqual((await store.list()).map((site) => site.slug), ['valid-slug'])
})
