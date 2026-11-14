/**
 * 更新锁：两个 Host 进程不能同时安装同一个 profile。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
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

test('lock: a lock left by a dead pid is taken over', async (t) => {
  const home = await fixture(t)
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(home, '.update-lock'), { recursive: true }))
  // 999999 超出常见 pid 上限，`kill(pid, 0)` 会以 ESRCH 失败。
  await writeFile(path.join(home, '.update-lock', 'owner.json'), JSON.stringify({ pid: 999999, at: 'earlier' }))
  const release = acquireUpdateLock(home)
  assert.equal(existsSync(path.join(home, '.update-lock', 'owner.json')), true)
  release()
  assert.equal(existsSync(path.join(home, '.update-lock', 'owner.json')), false)
})

test('lock: a half-written owner file is treated as stale', async (t) => {
  const home = await fixture(t)
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(home, '.update-lock'), { recursive: true }))
  await writeFile(path.join(home, '.update-lock', 'owner.json'), '{"pid":')
  const release = acquireUpdateLock(home)
  release()
})
