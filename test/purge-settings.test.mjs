import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SETTINGS, normalizeSettings, pickSwitches, readSettings, writeSettings } from '../host/purge/lib/settings.js'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yukari-purge-settings-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('defaults: every switch is on', () => {
  assert.deepEqual({ ...DEFAULT_SETTINGS }, { anchor: true, refusalRetry: true, stripHostLimits: true })
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS)
})

test('pickSwitches: only known boolean keys survive', () => {
  assert.deepEqual(pickSwitches({ anchor: false, prompt: 'x', nope: true, refusalRetry: 'yes' }), { anchor: false })
  assert.deepEqual(pickSwitches(null), {})
  assert.deepEqual(pickSwitches([]), {})
})

test('normalizeSettings: later layers win over earlier ones', () => {
  const merged = normalizeSettings({ anchor: false }, { refusalRetry: false })
  assert.deepEqual(merged, { anchor: false, refusalRetry: false, stripHostLimits: true })
})

test('readSettings: a missing or corrupt file falls back to the base layer', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'settings.json')
  assert.deepEqual(readSettings(file, { anchor: false }), { anchor: false, refusalRetry: true, stripHostLimits: true })

  await writeFile(file, '{ not json', 'utf8')
  assert.deepEqual(readSettings(file), DEFAULT_SETTINGS)
})

test('writeSettings: persists atomically, keeps the other switches, and is re-readable', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'settings.json')

  const first = writeSettings(file, { anchor: false }, DEFAULT_SETTINGS)
  assert.deepEqual(first, { anchor: false, refusalRetry: true, stripHostLimits: true })

  const second = writeSettings(file, { refusalRetry: false }, first)
  assert.deepEqual(second, { anchor: false, refusalRetry: false, stripHostLimits: true })
  assert.deepEqual(readSettings(file), second)

  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(raw, second, 'the file on disk is the effective settings, not the patch')
})
