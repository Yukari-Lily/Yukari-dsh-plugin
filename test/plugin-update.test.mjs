/**
 * 插件自更新与官方 Plugin Manager 的衔接：安装来源、固定 commit、热应用结果和旧版恢复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { installSource, installSourceKind, parseRepoSpec, updateProfile } from '../index.js'

/** Unit cases never reach the network; the preflight path is covered elsewhere. */
const runUpdate = (ctx, install, before) => updateProfile(ctx, install, before, { preflight: async () => {} })

const OLD_SHA = '1111111111111111111111111111111111111111'
const NEW_SHA = '2222222222222222222222222222222222222222'
const install = {
  kind: 'profile',
  profileDir: '/tmp/profile',
  real: '/tmp/profile/node_modules/yukari-dsh-plugin',
  repo: { owner: 'owner', repo: 'repo', ref: '' },
}
const before = { latest: '1.5.1', installed: '1.5.0', latestSha: NEW_SHA, installedSha: OLD_SHA }

function context(bundle, manager) {
  return {
    pluginManager: {
      listBundles: async () => [{ name: 'yukari-dsh-plugin', enabled: true, ...bundle }],
      ...manager,
    },
    get: (name) => name === 'hmr' ? {} : undefined,
    // 单元用例不联网；直连预检由 update-guard 用例单独覆盖。
    preflight: async () => {},
  }
}

test('pinned git source: the commit pins installation but does not replace the update branch', () => {
  const repo = parseRepoSpec(`github:owner/repo#${OLD_SHA}`)
  assert.equal(repo.ref, '', '固定安装之后仍跟踪仓库 HEAD，才能发现下一次更新')
})

test('install source: a GitHub spec is the only copy that can update itself', () => {
  const profile = (spec) => installSource({ kind: 'profile', profileDir: '/tmp/profile', spec, real: '/tmp/profile/node_modules/yukari-dsh-plugin' })
  assert.deepEqual(profile(`github:owner/repo#${OLD_SHA}`), {
    kind: 'github',
    updatable: true,
    repo: { owner: 'owner', repo: 'repo', ref: '' },
    source: `github:owner/repo#${OLD_SHA}`,
  })
  assert.equal(profile('owner/repo').kind, 'github')
})

test('install source: registry, package file and directory copies must not fall back to a written-in repo', () => {
  // 旧行为在这里会变成写死的 Yukari-Lily/Yukari-dsh-plugin，于是 npm 或安装包装的副本
  // 会去问一个自己装不回来的仓库，甚至被迁移成 Git 安装。
  const profile = (spec) => installSource({ kind: 'profile', profileDir: '/tmp/profile', spec, real: '/tmp/profile/node_modules/yukari-dsh-plugin' })
  for (const [spec, kind] of [
    ['yukari-dsh-plugin', 'registry'],
    ['yukari-dsh-plugin@0.7.1', 'registry'],
    ['https://example.com/yukari-dsh-plugin-0.7.1.tgz', 'tarball'],
    ['/tmp/pkg/yukari-dsh-plugin-0.7.1.tgz', 'tarball'],
    ['file:/tmp/pkg/yukari-dsh-plugin-0.7.1.tgz', 'tarball'],
    ['file:/tmp/pkg', 'path'],
    ['/tmp/pkg', 'path'],
    ['git+https://git.example.com/owner/repo.git', 'git'],
  ]) {
    const source = profile(spec)
    assert.equal(source.kind, kind, spec)
    assert.equal(source.updatable, false, spec)
    assert.equal(source.repo, null, spec)
    assert.equal(source.source, spec, spec)
  }
})

test('install source: a checkout of this repository keeps updating from GitHub', () => {
  const source = installSource({ kind: 'git', dir: '/workspace/plugin', repo: { owner: 'owner', repo: 'repo', ref: '' } })
  assert.deepEqual(source, { kind: 'github', updatable: true, repo: { owner: 'owner', repo: 'repo', ref: '' }, source: 'owner/repo' })
})

test('install source: an unreadable install cannot update and names no repository', () => {
  assert.equal(installSourceKind(''), 'unknown')
  assert.deepEqual(installSource({ kind: 'unknown', real: '/tmp/elsewhere' }), { kind: 'unknown', updatable: false, repo: null, source: '' })
})

test('pinned git install: the official updater owns replacement and reports applied', async () => {
  const calls = []
  const ctx = context({ update: 'git' }, {
    updateBundle: async (...args) => {
      calls.push(args)
      return { result: { changed: true, application: 'applied', version: '1.5.1' } }
    },
  })
  const result = await runUpdate(ctx, install, before)
  assert.deepEqual(calls, [[
    'yukari-dsh-plugin',
    '1.5.1',
    { spec: `github:owner/repo#${NEW_SHA}` },
  ]])
  assert.deepEqual(result, { updated: true, installed: '1.5.1', application: 'applied', restartReason: null })
})

test('rewritten history: a lower version still updates through the pinned commit', async () => {
  // 官方 updateBundle 要求 semver.gt，版本号回退时会被拒；更新只认 commit，所以必须绕开它。
  const calls = []
  const ctx = context({ update: 'git' }, {
    updateBundle: async () => {
      throw new Error('updateBundle 不该被调用：目标版本没有变高')
    },
    removeBundle: async (name) => {
      calls.push(['remove', name])
      return { application: 'applied' }
    },
    installBundle: async (spec, options) => {
      calls.push(['install', spec, options])
      return { changed: true, application: 'applied', version: '1.5.0' }
    },
  })
  const result = await runUpdate(ctx, install, { latest: '1.5.0', installed: '1.5.10', latestSha: NEW_SHA, installedSha: OLD_SHA })
  assert.equal(result.application, 'applied')
  assert.deepEqual(calls, [
    ['remove', 'yukari-dsh-plugin'],
    ['install', `github:owner/repo#${NEW_SHA}`, {
      enabled: true,
      expected: { name: 'yukari-dsh-plugin', version: '1.5.0' },
    }],
  ])
})

test('unknown remote version without HMR: installs the commit and omits the unchecked version', async () => {
  const calls = []
  const ctx = context({ source: 'github:owner/repo' }, {
    installBundle: async (spec, options) => {
      calls.push(['install', spec, options])
      return { changed: true, application: 'restart-required', restartReason: 'no-hmr', version: '0.8.0' }
    },
  })
  ctx.get = () => undefined
  const result = await runUpdate(ctx, install, {
    latest: '0.7.8',
    latestKnown: false,
    installed: '0.7.8',
    latestSha: NEW_SHA,
    installedSha: OLD_SHA,
  })
  assert.equal(result.installed, '0.8.0')
  assert.deepEqual(calls, [['install', `github:owner/repo#${NEW_SHA}`, { enabled: true }]])
})

test('branch install: the one-time migration installs a pinned target through the manager', async () => {
  const calls = []
  const ctx = context({ source: 'github:owner/repo' }, {
    removeBundle: async (name) => {
      calls.push(['remove', name])
      return { application: 'applied' }
    },
    installBundle: async (spec, options) => {
      calls.push(['install', spec, options])
      return { changed: true, application: 'applied', version: '1.5.1' }
    },
  })
  const result = await runUpdate(ctx, install, before)
  assert.equal(result.application, 'applied')
  assert.deepEqual(calls, [
    ['remove', 'yukari-dsh-plugin'],
    ['install', `github:owner/repo#${NEW_SHA}`, {
      enabled: true,
      expected: { name: 'yukari-dsh-plugin', version: '1.5.1' },
    }],
  ])
})

test('unknown remote version: install the pinned commit without expecting the running version', async () => {
  // Windows 上 raw.githubusercontent.com 的 Node fetch 可能失败，而 git ls-remote 正常。
  // 此时 latest 只是界面兜底的当前版本，绝不能作为目标包的 expected.version：
  // 0.7.8 → 6ef03e4 实际是 0.8.0，旧代码会安装成功后校验失败并回滚。
  const calls = []
  const ctx = context({ update: 'git' }, {
    updateBundle: async () => {
      throw new Error('版本未知时不能走需要 semver 比较的 updateBundle')
    },
    removeBundle: async (name) => {
      calls.push(['remove', name])
      return { application: 'applied' }
    },
    installBundle: async (spec, options) => {
      calls.push(['install', spec, options])
      return { changed: true, application: 'applied', version: '0.8.0' }
    },
  })
  const result = await runUpdate(ctx, install, {
    latest: '0.7.8',
    latestKnown: false,
    installed: '0.7.8',
    latestSha: NEW_SHA,
    installedSha: OLD_SHA,
  })
  assert.equal(result.installed, '0.8.0', 'the installed package reports its real version')
  // 管理器要求 expected 带成对的名字与版本，传半截会被当成装错了包；版本未知就不传。
  assert.deepEqual(calls, [
    ['remove', 'yukari-dsh-plugin'],
    ['install', `github:owner/repo#${NEW_SHA}`, { enabled: true }],
  ])
})

test('branch install without HMR: the official manager installs over it and validates the target', async () => {
  const calls = []
  const ctx = context({ source: 'github:owner/repo' }, {
    installBundle: async (spec, options) => {
      calls.push(['install', spec, options])
      return { changed: true, application: 'restart-required', restartReason: 'no-hmr', version: '1.5.1' }
    },
  })
  ctx.get = () => undefined
  const result = await runUpdate(ctx, install, before)
  assert.equal(result.application, 'restart-required')
  assert.equal(result.restartReason, 'no-hmr')
  assert.deepEqual(calls, [[
    'install',
    `github:owner/repo#${NEW_SHA}`,
    { enabled: true, expected: { name: 'yukari-dsh-plugin', version: '1.5.1' } },
  ]])
})

test('non-default branch: migration refuses before silently switching update tracking to HEAD', async () => {
  let called = false
  const ctx = context({ source: 'github:owner/repo#dev' }, {
    removeBundle: async () => {
      called = true
      return { application: 'applied' }
    },
    installBundle: async () => {
      called = true
      return { application: 'applied' }
    },
  })
  await assert.rejects(runUpdate(ctx, { ...install, repo: { ...install.repo, ref: 'dev' } }, before), /非默认分支/u)
  assert.equal(called, false)
})

test('branch migration failure: restore the exact old commit, not the moving branch', async () => {
  const installed = []
  const ctx = context({ source: 'github:owner/repo' }, {
    removeBundle: async () => ({ application: 'applied' }),
    installBundle: async (spec) => {
      installed.push(spec)
      if (installed.length === 1) {
        return { application: 'failed', stage: 'install', error: { diagnostic: 'target failed' } }
      }
      return { changed: true, application: 'applied', version: '1.5.0' }
    },
  })
  await assert.rejects(runUpdate(ctx, install, before), /target failed；已恢复旧版/u)
  assert.deepEqual(installed, [`github:owner/repo#${NEW_SHA}`, `github:owner/repo#${OLD_SHA}`])
})

test('branch migration activation failure: remove the target before restoring the old commit', async () => {
  const calls = []
  const ctx = context({ source: 'github:owner/repo' }, {
    removeBundle: async (name) => {
      calls.push(['remove', name])
      return { application: 'applied' }
    },
    installBundle: async (spec) => {
      calls.push(['install', spec])
      if (calls.length === 2) return { application: 'failed', stage: 'enable', error: { diagnostic: 'start failed' } }
      return { changed: true, application: 'applied', version: '1.5.0' }
    },
  })
  await assert.rejects(runUpdate(ctx, install, before), /start failed；已恢复旧版/u)
  assert.deepEqual(calls, [
    ['remove', 'yukari-dsh-plugin'],
    ['install', `github:owner/repo#${NEW_SHA}`],
    ['remove', 'yukari-dsh-plugin'],
    ['install', `github:owner/repo#${OLD_SHA}`],
  ])
})

test('branch migration: an unknown old commit refuses before removing the installed copy', async () => {
  let removed = false
  const ctx = context({ source: 'github:owner/repo' }, {
    removeBundle: async () => {
      removed = true
      return { application: 'applied' }
    },
  })
  await assert.rejects(runUpdate(ctx, install, { ...before, installedSha: null }), /没有取得目标 commit/u)
  assert.equal(removed, false)
})

test('branch migration exception: a thrown install failure still restores the old commit', async () => {
  const installed = []
  const ctx = context({ source: 'github:owner/repo' }, {
    removeBundle: async () => ({ application: 'applied' }),
    installBundle: async (spec) => {
      installed.push(spec)
      if (installed.length === 1) throw new Error('install exploded')
      return { changed: true, application: 'applied', version: '1.5.0' }
    },
  })
  await assert.rejects(runUpdate(ctx, install, before), /install exploded；已恢复旧版/u)
  assert.deepEqual(installed, [`github:owner/repo#${NEW_SHA}`, `github:owner/repo#${OLD_SHA}`])
})

test('restore requiring restart: the failure does not claim the old version is already running', async () => {
  const ctx = context({ update: 'git' }, {
    updateBundle: async () => ({
      result: { application: 'failed', stage: 'enable', error: { diagnostic: 'target failed' } },
      restore: { application: 'restart-required', restartReason: 'package-moved' },
    }),
  })
  await assert.rejects(runUpdate(ctx, install, before), /旧版已安装，重启后恢复/u)
})

test('official update failure: include whether the manager restored the old version', async () => {
  const ctx = context({ update: 'git' }, {
    updateBundle: async () => ({
      result: { application: 'failed', stage: 'install', error: { diagnostic: 'target failed' } },
      restore: { application: 'failed', stage: 'install' },
    }),
  })
  await assert.rejects(runUpdate(ctx, install, before), /target failed；旧版恢复失败/u)
})

test('a failed install reports the official restore result without a file fallback', async () => {
  const calls = []
  const ctx = context({ source: 'github:owner/repo' }, {
    removeBundle: async () => ({ application: 'applied' }),
    installBundle: async (spec) => {
      calls.push(spec)
      return { application: 'failed', stage: 'spec-host', error: { diagnostic: 'network down' } }
    },
  })
  await assert.rejects(runUpdate(ctx, install, before), /network down；旧版恢复失败/u)
  assert.deepEqual(calls, [`github:owner/repo#${NEW_SHA}`, `github:owner/repo#${OLD_SHA}`])
})

test('after an install, a bundle that failed to load is reported instead of accepted', async () => {
  const ctx = context({ update: 'git' }, {
    updateBundle: async () => ({ result: { changed: true, application: 'applied', version: '1.5.1' } }),
  })
  let first = true
  const healthy = ctx.pluginManager.listBundles
  ctx.pluginManager.listBundles = async () => {
    if (first) {
      first = false
      return healthy()
    }
    return [{ name: 'yukari-dsh-plugin', enabled: true, installed: true, error: { code: 'load-failed' }, rows: [] }]
  }
  await assert.rejects(runUpdate(ctx, install, before), /没有被加载（load-failed）/u)
})

test('after an install, bundle rows that never became live entries are reported', async () => {
  const ctx = context({ update: 'git' }, {
    updateBundle: async () => ({ result: { changed: true, application: 'applied', version: '1.5.1' } }),
  })
  let first = true
  const healthy = ctx.pluginManager.listBundles
  ctx.pluginManager.listBundles = async () => {
    if (first) {
      first = false
      return healthy()
    }
    return [{ name: 'yukari-dsh-plugin', enabled: true, installed: true, rows: [{ rowId: 'yukari' }] }]
  }
  await assert.rejects(runUpdate(ctx, install, before), /插件行没有生效/u)
})

test('after an install, an unreadable bundle list is its own failure', async () => {
  const ctx = context({ update: 'git' }, {
    updateBundle: async () => ({ result: { changed: true, application: 'applied', version: '1.5.1' } }),
  })
  let first = true
  const healthy = ctx.pluginManager.listBundles
  ctx.pluginManager.listBundles = async () => {
    if (first) {
      first = false
      return healthy()
    }
    throw new Error('profile locked')
  }
  await assert.rejects(runUpdate(ctx, install, before), /无法读取插件列表.*profile locked/u)
})

test('without HMR a missing bundle row is an error instead of a restart', async () => {
  let installs = 0
  const ctx = context({ source: 'github:owner/repo' }, {
    installBundle: async () => {
      installs += 1
      return { changed: true, application: 'restart-required', version: '1.5.1' }
    },
  })
  let first = true
  ctx.pluginManager.listBundles = async () => {
    if (first) {
      first = false
      return [{ name: 'yukari-dsh-plugin', source: 'github:owner/repo', enabled: true }]
    }
    return []
  }
  ctx.get = () => undefined
  await assert.rejects(runUpdate(ctx, install, before), /没有注册为已启用/u)
  assert.equal(installs, 1)
})
