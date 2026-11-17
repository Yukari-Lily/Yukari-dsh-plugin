/**
 * 更新锁：两个 Host 进程不能同时安装同一个 profile。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireUpdateLock } from '../host/runtime/lib/update-guard.js'

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yk-update-'))
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true })))
  return dir
}

test('lock: a second process is refused while the holder is alive', async (t) => {
  const home = await fixture(t)
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(home, '.update-lock'), { recursive: true }))
  await writeFile(path.join(home, '.update-lock', 'owner.json'), JSON.stringify({ pid: process.pid, at: 'now' }))
  assert.throws(() => acquireUpdateLock(home), (error) => {
    assert.equal(error.status, 409)
    assert.match(error.message, /另一个 Harness 进程/)
    return true
  })
})

test('lock: a complete lock publishes atomically and releases cleanly', async (t) => {
  const home = await fixture(t)
  const release = acquireUpdateLock(home)
  assert.equal(existsSync(path.join(home, '.update-lock', 'owner.json')), true)
  assert.deepEqual(await readdir(path.join(home, '.update-lock')), ['owner.json'], 'atomic publication leaves no temporary sibling')
  release()
  assert.equal(existsSync(path.join(home, '.update-lock', 'owner.json')), false)
})

test('lock: a dead holder is reported without deleting the lock', async (t) => {
  const home = await fixture(t)
  await mkdir(path.join(home, '.update-lock'), { recursive: true })
  const file = path.join(home, '.update-lock', 'owner.json')
  // 999999 超出常见 pid 上限，`kill(pid, 0)` 会以 ESRCH 失败。
  await writeFile(file, JSON.stringify({ pid: 999999, at: 'earlier' }))
  assert.throws(() => acquireUpdateLock(home), /未自动删除/u)
  assert.equal(existsSync(file), true, 'a stale-looking file is never replaced by a racing update')
})

test('lock: a half-written owner file is preserved for manual recovery', async (t) => {
  const home = await fixture(t)
  await mkdir(path.join(home, '.update-lock'), { recursive: true })
  const file = path.join(home, '.update-lock', 'owner.json')
  await writeFile(file, '{"pid":')
  assert.throws(() => acquireUpdateLock(home), /未自动删除/u)
  assert.equal(existsSync(file), true)
})

test('update: loopback proxy variables are cleared so the installer goes direct', async () => {
  const { releaseLocalEgress } = await import('../index.js')
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
  const watched = [...names, 'NODE_USE_ENV_PROXY', 'NO_PROXY']
  const previous = Object.fromEntries(watched.map((name) => [name, process.env[name]]))
  try {
    for (const name of names) process.env[name] = 'http://127.0.0.1:17890'
    process.env.NODE_USE_ENV_PROXY = '1'
    process.env.NO_PROXY = 'localhost'
    const cleared = releaseLocalEgress()
    assert.deepEqual(cleared.sort(), [...names].sort())
    for (const name of names) assert.equal(process.env[name], undefined)
    assert.equal(process.env.NODE_USE_ENV_PROXY, undefined)
    assert.equal(process.env.NO_PROXY, 'localhost', 'the bypass list is harmless without proxy variables')

    process.env.HTTPS_PROXY = 'http://[::1]:17890'
    assert.deepEqual(releaseLocalEgress(), ['HTTPS_PROXY'], 'an IPv6 loopback listener is ours too')

    process.env.HTTP_PROXY = 'http://proxy.corp.example:3128'
    assert.deepEqual(releaseLocalEgress(), [])
    assert.equal(process.env.HTTP_PROXY, 'http://proxy.corp.example:3128', "an operator's proxy survives")
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

/** Proxy variables `releaseLocalEgress` may clear while an update test runs. */
function watchEgress(t) {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

/** A profile install pointing at a temp copy, plus its update result fixture. */
async function profileFixture(t) {
  const home = await fixture(t)
  const source = path.join(home, 'installed')
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'yukari-dsh-plugin', version: '0.8.0' }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  watchEgress(t)
  return {
    home,
    install: { kind: 'profile', real: source, dir: source, repo: { owner: 'Yukari-Lily', repo: 'Yukari-dsh-plugin', ref: '' } },
    before: { latest: '0.9.0', latestSha: 'a'.repeat(40), installed: '0.8.0', installedSha: 'b'.repeat(40) },
  }
}

function updateContext(manager) {
  return {
    pluginManager: manager,
    get: (name) => (name === 'hmr' ? {} : undefined),
    logger: () => ({ warn: () => {} }),
  }
}

test('update: a failed direct-network preflight cancels before the old copy is removed', async (t) => {
  const { updateProfile } = await import('../index.js')
  const { install, before } = await profileFixture(t)
  // 同版本换 commit：这条路径要先卸载，因此必须直连可用。
  const sameVersion = { ...before, latest: before.installed }
  let removed = false
  const manager = {
    async listBundles() {
      return [{ name: 'yukari-dsh-plugin', update: 'git', enabled: true }]
    },
    async updateBundle() {
      throw new Error('an in-place update is not this path')
    },
    async removeBundle() {
      removed = true
      throw new Error('must not run')
    },
    async installBundle() {
      removed = true
      throw new Error('must not run')
    },
  }
  await assert.rejects(
    updateProfile(updateContext(manager), install, sameVersion, {
      preflight: async () => {
        throw new Error('direct github unavailable')
      },
    }),
    /direct github unavailable/,
  )
  assert.equal(removed, false, 'nothing is uninstalled before direct access is proven')
})

test('update: an in-place upgrade keeps the proxy route and needs no direct check', async (t) => {
  const { updateProfile } = await import('../index.js')
  const { install, before } = await profileFixture(t)
  const loopback = 'http://127.0.0.1:17890'
  process.env.HTTP_PROXY = loopback
  process.env.HTTPS_PROXY = loopback
  let preflights = 0
  const manager = {
    async listBundles() {
      return [{ name: 'yukari-dsh-plugin', update: 'git', enabled: true }]
    },
    async updateBundle() {
      // 安装期间插件仍在盘上，代理监听器也仍在：子进程可以用它自己的路由。
      assert.equal(process.env.HTTPS_PROXY, loopback, 'the loopback route must still be published while pnpm runs')
      return { result: { application: 'applied', changed: true, version: '0.9.0' } }
    },
  }
  const result = await updateProfile(updateContext(manager), install, before, {
    preflight: async () => {
      preflights += 1
      throw new Error('direct github unavailable')
    },
  })
  assert.equal(result.installed, '0.9.0')
  assert.equal(preflights, 0, 'an in-place upgrade never requires direct access')
})

test('update: the direct child environment keeps everything but the proxy names', async (t) => {
  const { directChildEnv } = await import('../index.js')
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  for (const name of names) process.env[name] = 'http://127.0.0.1:17890'
  process.env.DSH_E2E_MARKER = 'kept'
  t.after(() => { delete process.env.DSH_E2E_MARKER })
  const env = directChildEnv()
  for (const name of names) assert.equal(env[name], undefined)
  assert.equal(env.DSH_E2E_MARKER, 'kept')
  assert.equal(env.PATH, process.env.PATH)
})

test('update: releasing the host policy is safe when the host module is not reachable', async () => {
  const { releaseHostProxyPolicy } = await import('../index.js')
  // The test process entry is not the Host CLI, so no policy can be resolved.
  assert.equal(await releaseHostProxyPolicy(), false)
})

test('update: the preflight seam is never read off the Cordis context', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(/ctx\.preflight/.test(source), false, 'reading an uninjected property throws on a real Cordis context')
})

test('update: a missing bundle row reports failure without a second install', async (t) => {
  const { updateProfile } = await import('../index.js')
  const { install, before } = await profileFixture(t)
  let installs = 0
  const manager = {
    async listBundles() {
      return [{ name: 'yukari-dsh-plugin', update: 'git', enabled: true, installed: false }]
    },
    async updateBundle() {
      return { result: { application: 'applied', changed: true, version: '0.9.0' } }
    },
    async installBundle() {
      installs += 1
      return { application: 'restart-required', stage: 'install' }
    },
  }
  await assert.rejects(updateProfile(updateContext(manager), install, before, { preflight: async () => {} }), (error) => {
    assert.match(error.message, /没有注册/u)
    assert.doesNotMatch(error.message, /已恢复旧版/u)
    return true
  })
  assert.equal(installs, 0, 'the still-installed target is not replaced by a file dependency')
})
