import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { legacySibling, migratePath } from '../host/shared/migrate.js'

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yk-migrate-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('migratePath moves a file once and keeps its contents', async (t) => {
  const dir = await temp(t)
  const from = path.join(dir, 'yukari-thing.json')
  const to = path.join(dir, 'thing.json')
  await writeFile(from, '{"kept":true}')

  assert.equal(migratePath(from, to), 'moved')
  assert.equal(await readFile(to, 'utf8'), '{"kept":true}')
  await assert.rejects(readFile(from, 'utf8'))
})

test('migratePath moves a directory with its private files', async (t) => {
  const dir = await temp(t)
  const from = path.join(dir, 'yukari-token')
  const to = path.join(dir, 'token')
  await mkdir(from)
  await writeFile(path.join(from, 'secret'), 'x')

  assert.equal(migratePath(from, to), 'moved')
  assert.equal(await readFile(path.join(to, 'secret'), 'utf8'), 'x')
})

test('migratePath never overwrites or deletes', async (t) => {
  const dir = await temp(t)
  const from = path.join(dir, 'yukari-a.json')
  const to = path.join(dir, 'a.json')
  await writeFile(from, 'old')
  await writeFile(to, 'new')

  assert.equal(migratePath(from, to), 'kept')
  assert.equal(await readFile(to, 'utf8'), 'new')
  assert.equal(await readFile(from, 'utf8'), 'old', 'the legacy copy is left alone')

  assert.equal(migratePath(path.join(dir, 'absent'), path.join(dir, 'other')), 'kept')
  assert.deepEqual((await readdir(dir)).sort(), ['a.json', 'yukari-a.json'])
})

test('legacySibling derives the old name next to the current one', () => {
  assert.equal(legacySibling('/home/n/.dsh/presets.json', 'yukari-presets.json'), '/home/n/.dsh/yukari-presets.json')
})
