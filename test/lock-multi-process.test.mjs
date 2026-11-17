/**
 * 多进程争用更新锁：真的 spawn 子进程，确认同一时刻只有一个持有者。
 *
 * 单进程用例证明不了"两个 Host 同时安装"这件事：锁的意义就在进程边界上。
 * 这里让子进程等到同一个时刻再抢锁，赢家持锁一小段时间，其余必须被拒；
 * 陈旧锁和半截锁则必须原样保留，供人工确认。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireUpdateLock } from '../host/runtime/lib/update-guard.js'

const SELF = fileURLToPath(import.meta.url)

// 子进程模式：跑到同一个时刻再抢锁，抢到就持有一小段时间，交给父进程判定。
if (process.env.LOCK_RACE_CHILD === '1') {
  const home = process.env.LOCK_RACE_HOME
  const startAt = Number(process.env.LOCK_RACE_START)
  const holdMs = Number(process.env.LOCK_RACE_HOLD ?? '0')
  while (Date.now() < startAt) { /* 等统一的开抢时刻 */ }
  try {
    const release = acquireUpdateLock(home)
    if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs))
    release()
    process.stdout.write('WON')
  } catch (error) {
    process.stdout.write(`LOCKED ${error.status} ${error.message}`)
  }
  process.exit(0)
}

/** 一个参与争抢的子进程。 */
function racer(home, startAt, holdMs = 0) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SELF], {
      env: {
        ...process.env,
        LOCK_RACE_CHILD: '1',
        LOCK_RACE_HOME: home,
        LOCK_RACE_START: String(startAt),
        LOCK_RACE_HOLD: String(holdMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    proc.stdout.on('data', (chunk) => { output += chunk })
    proc.stderr.on('data', (chunk) => { output += chunk })
    proc.on('close', () => resolve(output.trim()))
  })
}

/** 临时 home，用完就删。 */
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yk-lock-race-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex')
const ownerFile = (home) => path.join(home, '.update-lock', 'owner.json')

test('lock race: processes started together yield exactly one holder', async (t) => {
  const home = await fixture(t)
  const startAt = Date.now() + 600
  // 持锁时间要明显长于子进程的启动抖动，否则某个晚起的进程会在释放后再拿到锁。
  const results = await Promise.all(Array.from({ length: 6 }, () => racer(home, startAt, 1500)))
  const winners = results.filter((output) => output === 'WON')
  const refused = results.filter((output) => output.includes('另一个 Harness 进程'))
  assert.equal(winners.length, 1, `exactly one process may hold the lock, got ${results.join(' | ')}`)
  assert.equal(refused.length, 5, 'every other process must see the live holder')
  assert.equal(results.some((output) => output.includes('未自动删除')), false, 'a lock being held is never read as stale')
  assert.deepEqual(await readdir(path.join(home, '.update-lock')).catch(() => []), [], 'no temporary file survives a round')
})

test('lock race: a released lock is available to the next process', async (t) => {
  const home = await fixture(t)
  const first = await racer(home, Date.now() - 1, 0)
  assert.equal(first, 'WON')
  const second = await racer(home, Date.now() - 1, 0)
  assert.equal(second, 'WON', 'the holder released it, so the next attempt succeeds')
})

test('lock race: a stale or half-written lock is refused and left untouched', async (t) => {
  const home = await fixture(t)
  await mkdir(path.join(home, '.update-lock'), { recursive: true })
  for (const body of [JSON.stringify({ pid: 999999, at: 'earlier' }), '{"pid":']) {
    await writeFile(ownerFile(home), body)
    const before = sha1(await readFile(ownerFile(home)))
    const results = await Promise.all(Array.from({ length: 4 }, () => racer(home, Date.now() - 1, 0)))
    assert.equal(results.filter((output) => output.includes('未自动删除')).length, 4, `every attempt refuses ${body}`)
    assert.equal(results.some((output) => output === 'WON'), false, 'nobody takes over a lock that needs a human decision')
    assert.equal(sha1(await readFile(ownerFile(home))), before, 'the lock file keeps its exact bytes')
    assert.deepEqual(await readdir(path.join(home, '.update-lock')), ['owner.json'], 'each attempt cleaned up its own temporary file')
  }
})

test('lock race: repeated rounds keep one winner per round', async (t) => {
  const home = await fixture(t)
  const winners = []
  for (let round = 0; round < 4; round += 1) {
    const startAt = Date.now() + 250
    const results = await Promise.all(Array.from({ length: 4 }, () => racer(home, startAt, 120)))
    winners.push(results.filter((output) => output === 'WON').length)
  }
  assert.deepEqual(winners, [1, 1, 1, 1], 'a create race must never produce two holders')
})
