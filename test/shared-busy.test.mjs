/**
 * The install lock shared by the main row and the runtime row.
 *
 * Two installers touching the same node_modules is the failure mode; the lock
 * has to refuse the second caller with 409 (not queue it), and it has to be
 * released when the first one throws.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { busyLabel, runExclusive } from '../host/shared/busy.js'

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('lock: a second caller is refused while the first is running', async () => {
  assert.equal(busyLabel(), null)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = runExclusive('安装更新', async () => {
    await gate
    return 'first'
  })
  await settle()
  assert.equal(busyLabel(), '安装更新')
  await assert.rejects(runExclusive('更新插件', async () => 'second'), (error) => {
    assert.equal(error.status, 409)
    assert.match(error.message, /正在安装更新/)
    return true
  })
  release()
  assert.equal(await first, 'first')
  assert.equal(busyLabel(), null)
})

test('lock: a throwing holder releases the lock for the next caller', async () => {
  await assert.rejects(runExclusive('更新插件', async () => {
    throw new Error('install failed')
  }), /install failed/)
  assert.equal(busyLabel(), null)
  assert.equal(await runExclusive('安装更新', async () => 'ok'), 'ok')
  assert.equal(busyLabel(), null)
})
