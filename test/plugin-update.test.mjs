/**
 * 插件自更新与官方 Plugin Manager 的衔接：固定 commit、热应用结果和旧版恢复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRepoSpec, updateProfile } from '../index.js'

const OLD_SHA = '1111111111111111111111111111111111111111'
const NEW_SHA = '2222222222222222222222222222222222222222'
const install = {
  kind: 'profile',
  profileDir: '/tmp/profile',
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
  }
}

test('pinned git source: the commit pins installation but does not replace the update branch', () => {
  const repo = parseRepoSpec(`github:owner/repo#${OLD_SHA}`)
  assert.equal(repo.ref, '', '固定安装之后仍跟踪仓库 HEAD，才能发现下一次更新')
})

test('pinned git install: the official updater owns replacement and reports applied', async () => {
  const calls = []
  const ctx = context({ update: 'git' }, {
    updateBundle: async (...args) => {
      calls.push(args)
      return { result: { changed: true, application: 'applied', version: '1.5.1' } }
    },
  })
  const result = await updateProfile(ctx, install, before)
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
  const result = await updateProfile(ctx, install, { latest: '1.5.0', installed: '1.5.10', latestSha: NEW_SHA, installedSha: OLD_SHA })
  assert.equal(result.application, 'applied')
  assert.deepEqual(calls, [
    ['remove', 'yukari-dsh-plugin'],
    ['install', `github:owner/repo#${NEW_SHA}`, {
      enabled: true,
      expected: { name: 'yukari-dsh-plugin', version: '1.5.0' },
    }],
  ])
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
  const result = await updateProfile(ctx, install, before)
  assert.equal(result.application, 'applied')
  assert.deepEqual(calls, [
    ['remove', 'yukari-dsh-plugin'],
    ['install', `github:owner/repo#${NEW_SHA}`, {
      enabled: true,
      expected: { name: 'yukari-dsh-plugin', version: '1.5.1' },
    }],
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
  const result = await updateProfile(ctx, install, before)
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
  await assert.rejects(updateProfile(ctx, { ...install, repo: { ...install.repo, ref: 'dev' } }, before), /非默认分支/u)
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
  await assert.rejects(updateProfile(ctx, install, before), /target failed；已恢复旧版/u)
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
  await assert.rejects(updateProfile(ctx, install, before), /start failed；已恢复旧版/u)
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
  await assert.rejects(updateProfile(ctx, install, { ...before, installedSha: null }), /没有取得目标 commit/u)
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
  await assert.rejects(updateProfile(ctx, install, before), /install exploded；已恢复旧版/u)
  assert.deepEqual(installed, [`github:owner/repo#${NEW_SHA}`, `github:owner/repo#${OLD_SHA}`])
})

test('restore requiring restart: the failure does not claim the old version is already running', async () => {
  const ctx = context({ update: 'git' }, {
    updateBundle: async () => ({
      result: { application: 'failed', stage: 'enable', error: { diagnostic: 'target failed' } },
      restore: { application: 'restart-required', restartReason: 'package-moved' },
    }),
  })
  await assert.rejects(updateProfile(ctx, install, before), /旧版已安装，重启后恢复/u)
})

test('official update failure: include whether the manager restored the old version', async () => {
  const ctx = context({ update: 'git' }, {
    updateBundle: async () => ({
      result: { application: 'failed', stage: 'install', error: { diagnostic: 'target failed' } },
      restore: { application: 'failed', stage: 'install' },
    }),
  })
  await assert.rejects(updateProfile(ctx, install, before), /target failed；旧版恢复失败/u)
})
