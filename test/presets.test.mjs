import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  BUILTIN_PRESETS,
  MAX_ROWS,
  entryListProblem,
  normalizeRows,
  readDefinition,
  readId,
  readMeta,
} from '../host/presets/lib/definition.js'
import { STORE_FILE, readStore, storePath, writeStore } from '../host/presets/lib/store.js'

async function temporary(t, prefix = 'yk-presets-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const row = (id, name, extra = {}) => ({ id, name, ...extra })

/* ------------------------------------------------------------------ normalize */

test('normalize: a platform marker becomes the concrete disabled flag', () => {
  const { plugins, notes } = normalizeRows([
    row('tool-bash', '@deepseek-ai/dsh-tool-bash', { platform: 'non-win32' }),
    row('tool-pwsh', '@deepseek-ai/dsh-tool-pwsh', { platform: 'win32' }),
  ])
  const [bash, pwsh] = plugins
  assert.equal('platform' in bash, false, 'the marker is not kept as a row field')
  assert.equal('platform' in pwsh, false)
  assert.equal(bash.disabled, process.platform === 'win32')
  assert.equal(pwsh.disabled, process.platform !== 'win32')
  assert.deepEqual(notes, ['platform'])
})

test('normalize: an explicit disabled flag wins over a platform marker', () => {
  const { plugins } = normalizeRows([row('a', '@x/a', { platform: 'win32', disabled: false })])
  assert.equal(plugins[0].disabled, false)
})

test('normalize: a !!js expression survives untouched', () => {
  const expression = { __jsExpr: "process.platform === 'win32'" }
  const { plugins } = normalizeRows([row('a', '@x/a', { disabled: expression })])
  assert.deepEqual(plugins[0].disabled, expression)
  // And a JSON round trip, which is what the store does, keeps it too.
  assert.deepEqual(JSON.parse(JSON.stringify(plugins[0].disabled)), expression)
})

test('normalize: unknown keys are dropped but config payloads are copied whole', () => {
  const { plugins } = normalizeRows([
    row('persona', '@deepseek-ai/dsh-persona', {
      platform: 'non-win32',
      note: 'not a Loader key',
      config: { prefix: '你好', nested: { deep: [1, 2, 3] } },
      inject: ['tools'],
    }),
  ])
  assert.deepEqual(Object.keys(plugins[0]).sort(), ['config', 'disabled', 'id', 'inject', 'name'])
  assert.deepEqual(plugins[0].config, { prefix: '你好', nested: { deep: [1, 2, 3] } })
})

test('normalize: group children keep their own shape', () => {
  const { plugins } = normalizeRows([
    row('planning', 'cordis:group', {
      group: true,
      isolate: { planMode: true },
      config: [row('plan-mode', '@deepseek-ai/dsh-plan-mode', { platform: 'win32' })],
    }),
  ])
  assert.equal(plugins[0].group, true)
  assert.equal(plugins[0].config[0].disabled, process.platform !== 'win32')
  assert.equal('platform' in plugins[0].config[0], false)
})

test('normalize: isolate and intercept survive a copy, they are Loader options', () => {
  // The registry refuses to mount a preset whose rows publish a service into the
  // root realm; a composition that hides those rows behind `isolate` fails to
  // start as soon as the copy drops the key.
  const { plugins } = normalizeRows([
    row('compaction', 'cordis:group', {
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [row('compaction-basic', '@deepseek-ai/dsh-compaction-basic')],
    }),
    row('persona', '@deepseek-ai/dsh-persona', { intercept: { tools: ['x'] } }),
  ])
  assert.deepEqual(plugins[0].isolate, { compaction: true, toolResultPruner: true })
  assert.deepEqual(plugins[1].intercept, { tools: ['x'] })
  // Still only Loader keys: a stray field is dropped as before.
  const stray = normalizeRows([row('a', '@x/a', { note: 'not a Loader key' })]).plugins[0]
  assert.equal('note' in stray, false)
})

test('normalize: a non-list input yields an empty composition, never a throw', () => {
  assert.deepEqual(normalizeRows(undefined), { plugins: [], notes: [] })
  assert.deepEqual(normalizeRows({ name: 'x' }), { plugins: [], notes: [] })
})

/* ------------------------------------------------------------------ validate */

test('entryListProblem: reports the first unusable row', () => {
  assert.equal(entryListProblem([]), undefined)
  assert.match(entryListProblem([{ id: 'a' }]), /缺少 name/u)
  assert.match(entryListProblem([{ name: '' }]), /缺少 name/u)
  assert.match(entryListProblem(['nope']), /不是插件行/u)
  assert.match(entryListProblem([{ name: '@x/a', disabled: 'yes' }]), /disabled/u)
  assert.match(entryListProblem([{ name: 'cordis:group', group: true, config: [{ id: 'x' }] }]), /第 1 行/u)
  assert.equal(entryListProblem([{ name: 'cordis:group', group: true, config: [] }]), undefined)
  assert.equal(entryListProblem('nope'), '组合必须是一行行插件的列表')
})

test('readId: shape, reserved ids and collisions', () => {
  assert.equal(readId('yk-demo'), 'yk-demo')
  assert.equal(readId('  a_b-1  '), 'a_b-1')
  for (const bad of ['', 'Demo', 'has space', '-lead', 'a'.repeat(65), '中文']) {
    assert.throws(() => readId(bad), /标识/u, `expected ${JSON.stringify(bad)} to be rejected`)
  }
  assert.throws(() => readId(BUILTIN_PRESETS[0]), /内置预设/u)
  assert.throws(() => readId('taken', { existing: ['taken'] }), /已经有预设/u)
})

test('readMeta: trims text, enforces ceilings and parses order', () => {
  assert.deepEqual(readMeta({ name: '  小说  ', description: '', order: '' }), {
    name: '小说',
    description: undefined,
    order: undefined,
  })
  assert.equal(readMeta({ order: '25' }).order, 25)
  assert.throws(() => readMeta({ name: 'x'.repeat(81) }), /80/u)
  assert.throws(() => readMeta({ description: 'x'.repeat(501) }), /500/u)
  assert.throws(() => readMeta({ order: -1 }), /排序/u)
  assert.throws(() => readMeta({ order: 1.5 }), /排序/u)
  assert.throws(() => readMeta({}, { requireName: true }), /名称/u)
})

test('readDefinition: builds the registry definition and rejects bad rows', () => {
  const { definition, notes } = readDefinition({
    id: 'yk-demo',
    name: '演示',
    description: '一句话',
    order: 7,
    plugins: [row('tool-bash', '@deepseek-ai/dsh-tool-bash', { platform: 'non-win32' })],
  })
  assert.deepEqual(Object.keys(definition).sort(), ['description', 'id', 'name', 'order', 'plugins'])
  assert.equal(definition.plugins[0].disabled, process.platform === 'win32')
  assert.deepEqual(notes, ['platform'])

  // A blank composition is allowed: it is what the panel's "empty" template is.
  assert.deepEqual(readDefinition({ id: 'yk-demo', name: 'x' }).definition.plugins, [])
  assert.throws(
    () => readDefinition({ id: 'yk-demo', name: 'x', plugins: Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ name: `@x/${i}` })) }),
    /500/u,
  )
  assert.throws(
    () => readDefinition({ id: 'standard', name: 'x', plugins: [] }),
    /内置预设/u,
  )
})

/* ---------------------------------------------------------------------- store */

test('store: a missing file is an empty store', async (t) => {
  const home = await temporary(t)
  const store = readStore(storePath(home))
  assert.equal(store.exists, false)
  assert.equal(store.error, null)
  assert.deepEqual(store.entries, [])
  assert.equal(store.path, path.join(home, STORE_FILE))
})

test('store: entries survive a round trip, and the file is private', async (t) => {
  const home = await temporary(t)
  const file = storePath(home)
  writeStore(file, [
    {
      id: 'yk-demo',
      name: '演示',
      description: '一句话',
      order: 3,
      plugins: [row('a', '@x/a', { disabled: { __jsExpr: 'true' } })],
    },
    { id: 'yk-blank', name: '空白', plugins: [] },
  ])
  const mode = (await stat(file)).mode & 0o777
  assert.equal(mode, 0o600)
  const store = readStore(file)
  assert.equal(store.error, null)
  assert.deepEqual(store.entries.map((entry) => entry.id), ['yk-demo', 'yk-blank'])
  assert.deepEqual(store.entries[0].plugins[0].disabled, { __jsExpr: 'true' })
  assert.equal(store.entries[0].problem, undefined)
  // No temporary sibling is left behind.
  assert.deepEqual((await readdir(home)).filter((name) => name.endsWith('.tmp')), [])
})

test('store: an unparsable file is an error, never a silent empty store', async (t) => {
  const home = await temporary(t)
  const file = storePath(home)
  await writeFile(file, '{ this is not json')
  const store = readStore(file)
  assert.match(store.error, /JSON/u)
  assert.deepEqual(store.entries, [])
  assert.equal(await readFile(file, 'utf8'), '{ this is not json', 'a read never rewrites the file')
})

test('store: a wrong version is refused', async (t) => {
  const home = await temporary(t)
  const file = storePath(home)
  await writeFile(file, JSON.stringify({ version: 99, presets: [] }))
  assert.match(readStore(file).error, /99/u)
})

test('store: one broken entry does not hide the healthy ones', async (t) => {
  const home = await temporary(t)
  const file = storePath(home)
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      presets: [
        { id: 'good', name: '好的', plugins: [{ name: '@x/a' }] },
        { id: 'dup', name: '一', plugins: [] },
        { id: 'dup', name: '二', plugins: [] },
        { id: 'bad', name: '坏', plugins: [{ id: 'no-name' }] },
      ],
    }),
  )
  const store = readStore(file)
  assert.equal(store.error, null)
  const byId = new Map(store.entries.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('good').problem, undefined)
  assert.match(byId.get('dup').problem, /重复/u)
  assert.match(byId.get('bad').problem, /缺少 name/u)
})
