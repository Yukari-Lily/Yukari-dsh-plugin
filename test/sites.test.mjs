import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

test('defaults: an empty row config publishes under the home directory at the default path', () => {
  const store = new SiteStore({ root: '', path: '' })
  assert.equal(store.root, path.join(os.homedir(), 'publish'), 'an empty root is not the process cwd')
  assert.equal(store.stateRoot, path.join(os.homedir(), '.publish-state'))
  assert.equal(store.sitePath, '/p', 'the default path is relative to this deployment')
  assert.equal(store.urlOf('demo'), '/p/demo/', 'links stay relative; the panel resolves them against its own address')
  const nested = new SiteStore({ path: '/sites/v1/' })
  assert.equal(nested.sitePath, '/sites/v1', 'the row config is normalized')
  assert.equal(nested.urlOf('demo'), '/sites/v1/demo/')
  const broken = new SiteStore({ path: '/Sites' })
  assert.equal(broken.sitePath, '/p', 'a row config that cannot be routed falls back instead of failing the boot')
  assert.equal(broken.rowPathRejection.code, 'path-invalid')
})

test('defaults: an upgrade keeps publishing into the directory the old default used', async (t) => {
  // 默认根从 /workspace/publish 改成 ~/publish 之后，升级上来的安装会对着一个空目录：
  // 站点还在旧目录里，面板却列不出来。接管旧目录，文件原地不动。
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'yk-sites-legacy-'))
  const previousHome = process.env.HOME
  // 旧目录与新默认根必须分处两个父目录，否则它们共用同一个 .publish-state。
  process.env.HOME = path.join(temporary, 'home')
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(temporary, { recursive: true, force: true })
  })
  const legacy = path.join(temporary, 'legacy', 'publish')
  const source = path.join(temporary, 'source')
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, 'index.html'), '<title>Old</title>')
  const old = new SiteStore({ root: legacy, legacyRoots: [legacy] })
  await old.publish({ source, slug: 'old-site' })

  const upgraded = new SiteStore({ root: '', legacyRoots: [legacy] })
  const listed = await upgraded.list()
  assert.equal(upgraded.root, legacy, 'the existing publish root wins over the new default')
  assert.equal(upgraded.adoptedFrom, legacy)
  assert.deepEqual(listed.map((site) => site.slug), ['old-site'])
  assert.equal(upgraded.sitePath, '/p')

  // 显式配过目录就不猜：新目录自己说了算。
  const explicit = new SiteStore({ root: path.join(temporary, 'fresh'), legacyRoots: [legacy] })
  assert.deepEqual(await explicit.list(), [])
  assert.equal(explicit.adoptedFrom, null)
})

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
  const list = tools.find((tool) => tool.name === 'list_sites').output.schema
  const item = list.properties.sites.items
  for (const field of ['files', 'version']) {
    assert.ok(item.properties[field])
    assert.ok(item.required.includes(field))
  }
  assert.ok(list.properties.root, 'the listing names the directory the files live in')
  assert.ok(list.required.includes('root'))
  const publish = tools.find((tool) => tool.name === 'publish_site').output.schema
  assert.ok(publish.properties.verifyUrl, 'the publish result names the address the Host itself answers on')
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

test('setSitePath accepts a nested path and refuses the shapes that cannot be routed', async (t) => {
  const { store } = await fixture(t)
  assert.equal(await store.setSitePath('/sites/'), '/sites', 'a trailing slash is normalized away')
  const codeOf = async (value) => {
    try {
      await store.setSitePath(value)
      return null
    } catch (error) {
      return error.appCode
    }
  }
  assert.equal(await codeOf('sites'), 'path-invalid', 'a path without the leading slash is a typo, not a host')
  assert.equal(await codeOf('/Sites'), 'path-invalid', 'the path is matched literally by the router')
  assert.equal(await codeOf('/a//b'), 'path-invalid')
  assert.equal(await codeOf('/a/../b'), 'path-invalid', 'a dot segment has no meaning in a prefix')
  assert.equal(await codeOf('/a?b'), 'path-invalid')
  assert.equal(await codeOf('/'), 'path-reserved')
  assert.equal(await codeOf('/api'), 'path-reserved')
  assert.equal(await codeOf('/api/remote.mux'), 'path-reserved')
  assert.equal(await codeOf('/plugins'), 'path-reserved')
  assert.equal(await codeOf('/publish/api'), 'path-reserved')
  assert.equal(store.sitePath, '/sites', 'a refused value leaves the saved one in effect')
})

test('setSitePath persists the path and goes back to the row config when cleared', async (t) => {
  const { store } = await fixture(t)
  await store.setSitePath('/sites')
  const reopened = new SiteStore({ root: store.root, stateRoot: store.stateRoot, path: '/row' })
  await reopened.init()
  assert.equal(reopened.sitePath, '/sites', 'a saved path beats the row config')
  assert.equal(await reopened.setSitePath(''), '/row', 'clearing the field restores the row config')
  const cleared = new SiteStore({ root: store.root, stateRoot: store.stateRoot, path: '/row' })
  await cleared.init()
  assert.equal(cleared.customSitePath, null)
})

test('setSitePath swaps the route first and leaves the settings untouched when the swap fails', async (t) => {
  const { store } = await fixture(t)
  const mounted = []
  // 换路由的回调自己负责把旧路由挂回去（index.js 的 swapSitePath 就是这么做的），
  // store 只保证：换失败时不动内存里的值、也不写盘。
  const mount = (value) => {
    if (value === '/taken') throw new Error('站点路径 /taken 已被其它功能占用')
    mounted.push(value)
  }
  await store.setSitePath('/sites', mount)
  assert.deepEqual(mounted, ['/sites'], 'the route moves before the settings file is written')
  await assert.rejects(store.setSitePath('/taken', mount), /已被其它功能占用/)
  assert.equal(store.sitePath, '/sites', 'the live path did not move')
  const reopened = new SiteStore({ root: store.root, stateRoot: store.stateRoot })
  await reopened.init()
  assert.equal(reopened.sitePath, '/sites', 'nothing was written for the refused path')
})

test('setSitePath puts the route back when the settings write fails', async (t) => {
  const { store } = await fixture(t)
  await store.init()
  const mounted = []
  // 状态目录改成不存在的路径：换路由会成功，写盘一定失败。
  store.stateRoot = path.join(store.stateRoot, 'missing', 'nested')
  await assert.rejects(store.setSitePath('/sites', (value) => mounted.push(value)), /ENOENT/)
  assert.deepEqual(mounted, ['/sites', '/p'], 'the route follows the settings file back to the old path')
  assert.equal(store.sitePath, '/p', 'the live path did not move')
})

test('init migrates the old public prefix into a mount path', async (t) => {
  // 0.7.8 及更早存的是完整地址，其中的路径就是当时的对外前缀。现在挂载路径
  // 本身就是对外路径，所以按那段路径迁移一次；没有路径的旧值回落到默认。
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'yk-sites-migrate-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const stateRoot = path.join(temporary, 'state')
  await mkdir(path.join(stateRoot, 'sites'), { recursive: true })
  const cases = [
    [{ publicBase: 'https://dsh.example.com/foo' }, '/foo', 'the old public path becomes the mount path'],
    [{ publicBase: 'https://pages.example.com' }, '/p', 'an address without a path keeps the default'],
    [{ publicBase: '/p' }, '/p', 'the old malformed value is still ignored'],
    [{ publicBase: 'not a url' }, '/p', 'an unreadable old value is still ignored'],
    [{ path: '/sites' }, '/sites', 'the new shape is read as is'],
    [{ path: '/Sites' }, '/p', 'a saved path that cannot be routed falls back'],
  ]
  for (const [saved, expected, message] of cases) {
    await writeFile(path.join(stateRoot, 'settings.json'), JSON.stringify(saved))
    const store = new SiteStore({ root: path.join(temporary, 'publish'), stateRoot })
    await store.init()
    assert.equal(store.sitePath, expected, message)
  }
})

test('init refuses a state directory inside the publish root', async (t) => {
  // 发布根现在由宿主直接对外提供，状态目录落在里面就成了公开文件。
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'yk-sites-state-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const store = new SiteStore({
    root: path.join(temporary, 'publish'),
    stateRoot: path.join(temporary, 'publish', 'state'),
  })
  await assert.rejects(store.init(), /状态目录不能位于发布目录内/)
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
