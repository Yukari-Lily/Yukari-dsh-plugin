import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../host/presets/index.js'
import { storePath } from '../host/presets/lib/store.js'

const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset'

/** One declared row, as the Loader holds it. */
function declaredRow(config) {
  return {
    id: `preset-${config.id}`,
    options: { id: `preset-${config.id}`, name: PRESET_PACKAGE, config: structuredClone(config) },
  }
}

const standardPlugins = () => [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent.' } },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: { __jsExpr: "process.platform !== 'win32'" } },
]

function createCtx(options = {}) {
  const routes = []
  const disposers = []
  const entries = (options.declared ?? []).map(declaredRow)
  /** store presets this plugin registered, in roster order. */
  const registered = new Map()
  const runtime = new Map((options.runtime ?? []).map((row) => [row.id, row]))
  const editCalls = []
  const emitted = []
  let defaultId = options.defaultId ?? 'standard'
  const describeCalls = []

  const editor = options.editor ?? {
    entries: () => entries,
    async edit(entry, change) {
      const next = change(structuredClone(entry.options.config))
      editCalls.push({ id: entry.id, config: next })
      entry.options.config = next
    },
  }

  const agentPresets = {
    get defaultId() {
      return defaultId
    },
    async register(definition) {
      if (
        registered.has(definition.id) ||
        entries.some((entry) => entry.options.config?.id === definition.id) ||
        runtime.has(definition.id)
      ) {
        throw new Error(`Duplicate agent preset: ${definition.id}`)
      }
      registered.set(definition.id, structuredClone(definition))
      return async () => {
        registered.delete(definition.id)
      }
    },
    async list() {
      const rows = entries.map((entry) => {
        const config = entry.options.config ?? {}
        const row = { id: config.id }
        if (config.name !== undefined) row.name = config.name
        if (config.description !== undefined) row.description = config.description
        if (config.order !== undefined) row.order = config.order
        return row
      })
      for (const row of runtime.values()) rows.push({ id: row.id, name: row.name })
      for (const definition of registered.values()) {
        const row = { id: definition.id }
        if (definition.name !== undefined) row.name = definition.name
        if (definition.description !== undefined) row.description = definition.description
        if (definition.order !== undefined) row.order = definition.order
        rows.push(row)
      }
      return rows.sort((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity) || left.id.localeCompare(right.id))
    },
    async readDocument(id) {
      return { agentPreset: id, content: `# ${id}\n- name: '@x/a'\n` }
    },
  }

  const settings = {
    describe() {
      describeCalls.push(Date.now())
      return [{ ns: 'agent-preset-registry', revision: 7 }]
    },
  }

  const ctx = {
    agentPresets,
    logger: { info() {}, warn() {} },
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    emit(...args) {
      emitted.push(args)
    },
    get(name) {
      if (name === 'configEditor') return options.noEditor === true ? undefined : editor
      if (name === 'settings') return options.noSettings === true ? undefined : settings
      return undefined
    },
  }

  return {
    ctx,
    routes,
    entries,
    registered,
    editCalls,
    describeCalls,
    emitted,
    setDefault(id) {
      defaultId = id
    },
    disposeAll() {
      for (const dispose of [...disposers].reverse()) dispose()
    },
  }
}

function call(route, method, url, body) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    body: '',
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(text) {
      this.body = text ?? ''
      this.headersSent = true
    },
  }
  return Promise.resolve(route.handler(req, res)).then(() => ({
    status: res.statusCode,
    json: res.body === '' ? null : JSON.parse(res.body),
  }))
}

async function withPlugin(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yk-presets-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })
  const harness = createCtx({
    declared: options.declared ?? [
      { id: 'standard', order: 1, plugins: standardPlugins() },
      { id: 'ptc', order: 2, plugins: [] },
      { id: 'minimal', order: 3, plugins: [] },
      { id: 'cordis', order: 4, plugins: [] },
      { id: 'novel', name: '小说模式', description: '写作', order: 25, plugins: standardPlugins() },
    ],
    runtime: options.runtime ?? [],
    ...options,
  })
  await apply(harness.ctx, {})
  t.after(() => harness.disposeAll())
  const route = () => harness.routes[0]
  return {
    home,
    file: storePath(home),
    ...harness,
    get: (url) => call(route(), 'GET', url),
    post: (action, body) => call(route(), 'POST', `/presets/api/${action}`, body),
  }
}

/* -------------------------------------------------------------------- state */

test('state: every preset is tagged with its source and the actions it allows', async (t) => {
  const plugin = await withPlugin(t, { runtime: [{ id: 'unrestricted', name: '无限制模式' }] })
  await writeFile(
    path.join(plugin.home, '.agent-presets', 'unrestricted', 'preset.json'),
    JSON.stringify({ name: '无限制模式', plugins: [{ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', platform: 'non-win32' }] }),
    { encoding: 'utf8', flag: 'w' },
  ).catch(async () => {
    await mkdir(path.join(plugin.home, '.agent-presets', 'unrestricted'), { recursive: true })
    await writeFile(
      path.join(plugin.home, '.agent-presets', 'unrestricted', 'preset.json'),
      JSON.stringify({ name: '无限制模式', plugins: [{ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', platform: 'non-win32' }] }),
    )
  })

  const state = await plugin.get('/presets/api/state')
  assert.equal(state.status, 200)
  const byId = new Map(state.json.items.map((item) => [item.id, item]))
  assert.deepEqual([...byId.keys()].sort(), ['cordis', 'minimal', 'novel', 'ptc', 'standard', 'unrestricted'])

  assert.equal(byId.get('standard').source, 'builtin')
  assert.equal(byId.get('standard').canEdit, false)
  assert.equal(byId.get('standard').canTemplate, true)
  assert.equal(byId.get('standard').canDelete, false)

  assert.equal(byId.get('novel').source, 'declared')
  assert.equal(byId.get('novel').canEdit, true)
  assert.equal(byId.get('novel').canDelete, false)

  // The runtime preset is readable through its owner's machine-readable file.
  assert.equal(byId.get('unrestricted').source, 'runtime')
  assert.equal(byId.get('unrestricted').canTemplate, true)
  assert.equal(byId.get('unrestricted').canEdit, false)

  assert.equal(byId.get('standard').isDefault, true)
  assert.equal(state.json.path, plugin.file)
  assert.equal(state.json.storeError, null)
})

test('state: a runtime preset without a definition file is view-only', async (t) => {
  const plugin = await withPlugin(t, { runtime: [{ id: 'ghost', name: '幽灵' }] })
  const state = await plugin.get('/presets/api/state')
  const ghost = state.json.items.find((item) => item.id === 'ghost')
  assert.equal(ghost.canTemplate, false)
  assert.match(ghost.reason, /运行时注册/u)

  const template = await plugin.get('/presets/api/template?id=ghost')
  assert.equal(template.status, 400)
  assert.match(template.json.error, /运行时注册/u)
})

/* ----------------------------------------------------------------- template */

test('template: a built-in preset resolves to its declared rows, normalized', async (t) => {
  const plugin = await withPlugin(t)
  const response = await plugin.get('/presets/api/template?id=standard')
  assert.equal(response.status, 200)
  assert.equal(response.json.source, 'builtin')
  const bash = response.json.plugins.find((row) => row.id === 'tool-bash')
  assert.equal(bash.disabled.__jsExpr, "process.platform === 'win32'")
  assert.deepEqual(response.json.plugins.map((row) => row.id), ['persona', 'tool-bash', 'tool-pwsh'])
})

test('template: a declared custom preset and a runtime definition file both resolve', async (t) => {
  const plugin = await withPlugin(t, { runtime: [{ id: 'unrestricted', name: '无限制模式' }] })
  const novel = await plugin.get('/presets/api/template?id=novel')
  assert.equal(novel.json.source, 'declared')
  assert.equal(novel.json.plugins.length, 3)

  const directory = path.join(plugin.home, '.agent-presets', 'unrestricted')
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'preset.json'),
    JSON.stringify({
      name: '无限制模式',
      plugins: [{ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', platform: 'non-win32' }],
    }),
  )
  const runtime = await plugin.get('/presets/api/template?id=unrestricted')
  assert.equal(runtime.status, 200)
  assert.equal(runtime.json.source, 'runtime')
  assert.equal(runtime.json.plugins[0].disabled, process.platform === 'win32')
  assert.equal('platform' in runtime.json.plugins[0], false)
  assert.equal(runtime.json.notes.length, 1)
})

test('template: an unknown id is refused', async (t) => {
  const plugin = await withPlugin(t)
  const response = await plugin.get('/presets/api/template?id=nope')
  assert.equal(response.status, 400)
  assert.match(response.json.error, /运行时注册|没有/u)
})

/* ------------------------------------------------------------------- create */

test('create: a preset built from a template is registered, persisted and listed', async (t) => {
  const plugin = await withPlugin(t)
  const before = plugin.describeCalls.length
  const created = await plugin.post('create', {
    id: 'yk-demo',
    name: '演示',
    description: '从标准模式复制',
    order: 40,
    plugins: standardPlugins(),
  })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  assert.equal(created.json.id, 'yk-demo')
  assert.ok(plugin.registered.has('yk-demo'), 'the registry took the definition')
  assert.ok(plugin.describeCalls.length > before, 'the roster change was announced')
  assert.deepEqual(plugin.emitted.at(-1), ['settings/document-updated', 'agent-preset-registry', 7])

  const state = await plugin.get('/presets/api/state')
  const item = state.json.items.find((row) => row.id === 'yk-demo')
  assert.equal(item.source, 'store')
  assert.equal(item.canEdit, true)
  assert.equal(item.canDelete, true)
  assert.equal(item.rows, 3)

  const stored = JSON.parse(await readFile(plugin.file, 'utf8'))
  assert.deepEqual(stored.presets.map((entry) => entry.id), ['yk-demo'])
  assert.equal(stored.presets[0].plugins[0].id, 'persona')

  // And the new preset is itself a template.
  const template = await plugin.get('/presets/api/template?id=yk-demo')
  assert.equal(template.json.source, 'store')
  assert.equal(template.json.plugins.length, 3)
})

test('create: a duplicate, reserved or malformed definition is refused and writes nothing', async (t) => {
  const plugin = await withPlugin(t)
  const cases = [
    [{ id: 'novel', name: 'x', plugins: [] }, /已经有预设/u],
    [{ id: 'standard', name: 'x', plugins: [] }, /内置预设/u],
    [{ id: 'Bad Id', name: 'x', plugins: [] }, /标识/u],
    [{ id: 'yk-a', name: '', plugins: [] }, /名称/u],
    [{ id: 'yk-a', name: 'x', plugins: [{ id: 'no-name' }] }, /缺少 name/u],
  ]
  for (const [body, pattern] of cases) {
    const response = await plugin.post('create', body)
    assert.equal(response.status, 400, `${JSON.stringify(body)} should be refused`)
    assert.match(response.json.error, pattern)
  }
  assert.equal(plugin.registered.size, 0)
  await assert.rejects(readFile(plugin.file, 'utf8'), /ENOENT/u)

  // The duplicate check also covers a preset this plugin registered a moment ago.
  const first = await plugin.post('create', { id: 'yk-a', name: 'A', plugins: [] })
  assert.equal(first.status, 200)
  const second = await plugin.post('create', { id: 'yk-a', name: 'A2', plugins: [] })
  assert.equal(second.status, 400)
  assert.match(second.json.error, /已经有预设/u)
})

/* ------------------------------------------------------------------- update */

test('update: a stored preset takes new metadata and rows', async (t) => {
  const plugin = await withPlugin(t)
  await plugin.post('create', { id: 'yk-demo', name: '演示', plugins: standardPlugins() })

  const updated = await plugin.post('update', {
    id: 'yk-demo',
    name: '演示二',
    description: '改过',
    order: 5,
    plugins: [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }],
  })
  assert.equal(updated.status, 200, JSON.stringify(updated.json))
  const definition = plugin.registered.get('yk-demo')
  assert.equal(definition.name, '演示二')
  assert.equal(definition.plugins.length, 1)
  assert.equal(definition.plugins[0].id, 'tool-fs')

  const stored = JSON.parse(await readFile(plugin.file, 'utf8'))
  assert.equal(stored.presets[0].name, '演示二')
  assert.equal(stored.presets[0].plugins.length, 1)
})

test('update: a rejected composition leaves the running preset and the file untouched', async (t) => {
  const plugin = await withPlugin(t)
  await plugin.post('create', { id: 'yk-demo', name: '演示', plugins: standardPlugins() })
  const before = await readFile(plugin.file, 'utf8')

  const failed = await plugin.post('update', {
    id: 'yk-demo',
    name: '演示',
    plugins: [{ id: 'broken', name: '' }],
  })
  assert.equal(failed.status, 400)
  assert.match(failed.json.error, /缺少 name/u)
  assert.equal(plugin.registered.get('yk-demo').plugins.length, 3, 'the previous registration is back')
  assert.equal(await readFile(plugin.file, 'utf8'), before)
})

test('update: the current default preset can still be edited', async (t) => {
  const plugin = await withPlugin(t)
  await plugin.post('create', { id: 'yk-demo', name: '演示', plugins: [] })
  plugin.setDefault('yk-demo')
  const updated = await plugin.post('update', { id: 'yk-demo', name: '新名字', plugins: [] })
  assert.equal(updated.status, 200)
})

/* ------------------------------------------------------------------- delete */

test('delete: removes the registration and the stored entry', async (t) => {
  const plugin = await withPlugin(t)
  await plugin.post('create', { id: 'yk-demo', name: '演示', plugins: [] })
  const removed = await plugin.post('delete', { id: 'yk-demo' })
  assert.equal(removed.status, 200)
  assert.equal(plugin.registered.has('yk-demo'), false)
  const stored = JSON.parse(await readFile(plugin.file, 'utf8'))
  assert.deepEqual(stored.presets, [])
  const state = await plugin.get('/presets/api/state')
  assert.equal(state.json.items.some((item) => item.id === 'yk-demo'), false)
})

test('delete: the default preset is refused, and stays registered', async (t) => {
  const plugin = await withPlugin(t)
  await plugin.post('create', { id: 'yk-demo', name: '演示', plugins: [] })
  plugin.setDefault('yk-demo')
  const refused = await plugin.post('delete', { id: 'yk-demo' })
  assert.equal(refused.status, 400)
  assert.match(refused.json.error, /当前默认/u)
  assert.ok(plugin.registered.has('yk-demo'))
})

test('delete: declared, built-in and runtime presets are refused', async (t) => {
  const plugin = await withPlugin(t, { runtime: [{ id: 'unrestricted', name: '无限制模式' }] })
  for (const id of ['novel', 'standard', 'unrestricted']) {
    const response = await plugin.post('delete', { id })
    assert.equal(response.status, 400, `${id} must not be deletable`)
    assert.match(response.json.error, /存档/u)
  }
})

/* ----------------------------------------------------------------- declared */

test('update: a declared preset goes through the config editor with a complete config', async (t) => {
  const plugin = await withPlugin(t)
  const rows = [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '新的身份' } }]
  const response = await plugin.post('update', { id: 'novel', name: '小说模式', description: '改过', order: 26, plugins: rows })
  assert.equal(response.status, 200, JSON.stringify(response.json))
  assert.equal(plugin.editCalls.length, 1)
  assert.equal(plugin.editCalls[0].id, 'preset-novel')
  assert.deepEqual(plugin.editCalls[0].config, {
    id: 'novel',
    plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '新的身份' } }],
    name: '小说模式',
    description: '改过',
    order: 26,
  })
})

test('update: an editor failure is reported as-is and changes nothing else', async (t) => {
  const declared = [
    { id: 'novel', name: '小说模式', plugins: [] },
  ]
  const editor = {
    entries: () => declared.map(declaredRow),
    async edit() {
      throw new Error('Configuration for "preset-novel" is overridden by a home patch or command-line overlay')
    },
  }
  const plugin = await withPlugin(t, { declared, editor })
  const response = await plugin.post('update', { id: 'novel', name: 'x', plugins: [] })
  assert.equal(response.status, 400)
  assert.match(response.json.error, /overridden/u)
  await assert.rejects(readFile(plugin.file, 'utf8'), /ENOENT/u, 'no store file was created')
})

test('update: built-in and runtime presets are read-only', async (t) => {
  const plugin = await withPlugin(t, { runtime: [{ id: 'unrestricted', name: '无限制模式' }] })
  for (const id of ['standard', 'unrestricted']) {
    const response = await plugin.post('update', { id, name: 'x', plugins: [] })
    assert.equal(response.status, 400, `${id} must be read-only`)
  }
  assert.equal(plugin.editCalls.length, 0)
})

test('update: without configEditor, declared presets cannot be edited but reads still work', async (t) => {
  const plugin = await withPlugin(t, { noEditor: true })
  const response = await plugin.post('update', { id: 'novel', name: 'x', plugins: [] })
  assert.equal(response.status, 400)
  assert.match(response.json.error, /configEditor/u)
  const state = await plugin.get('/presets/api/state')
  assert.equal(state.json.declaredAvailable, false)
  const standard = state.json.items.find((item) => item.id === 'standard')
  assert.equal(standard.canTemplate, false)
  assert.match(standard.reason, /configEditor/u)
})

/* -------------------------------------------------------------- broken store */

test('a broken store blocks writes but not declared edits', async (t) => {
  const plugin = await withPlugin(t)
  await writeFile(plugin.file, '{ nope')
  const created = await plugin.post('create', { id: 'yk-demo', name: '演示', plugins: [] })
  assert.equal(created.status, 400)
  assert.match(created.json.error, /JSON|写入/u)
  assert.equal(await readFile(plugin.file, 'utf8'), '{ nope', 'the unreadable file is never overwritten')

  const state = await plugin.get('/presets/api/state')
  assert.ok(state.json.storeError)

  const declared = await plugin.post('update', { id: 'novel', name: '小说模式', plugins: [] })
  assert.equal(declared.status, 200, 'the store must not block an unrelated edit')
})

/* -------------------------------------------------------------- routing edges */

test('routing: an unknown action is refused', async (t) => {
  const plugin = await withPlugin(t)
  const response = await call(plugin.routes[0], 'POST', '/presets/api/nope', {})
  assert.equal(response.status, 404)
  assert.match(response.json.error, /未知的操作/u)
})

test('routing: an oversized body is refused before parsing', async (t) => {
  const plugin = await withPlugin(t)
  const response = await call(plugin.routes[0], 'POST', '/presets/api/create', 'x'.repeat(600 * 1024))
  assert.equal(response.status, 400)
  assert.match(response.json.error, /too large/u)
})

test('get: one preset carries its metadata, rows and YAML', async (t) => {
  const plugin = await withPlugin(t)
  const response = await plugin.get('/presets/api/get?id=standard')
  assert.equal(response.status, 200)
  assert.equal(response.json.item.id, 'standard')
  assert.equal(response.json.plugins.length, 3)
  assert.match(response.json.yaml, /standard/u)
})

test('store: a damaged entry can be deleted, and other entries survive a create', async (t) => {
  const plugin = await withPlugin(t)
  await writeFile(
    plugin.file,
    JSON.stringify({
      version: 1,
      presets: [
        { id: 'yk-good', name: '好的', plugins: [] },
        { id: 'yk-bad', name: '坏的', plugins: [{ id: 'no-name' }] },
      ],
    }),
  )
  await plugin.get('/presets/api/state')
  const state = await plugin.get('/presets/api/state')
  const bad = state.json.items.find((item) => item.id === 'yk-bad')
  assert.match(bad.reason, /缺少 name/u)

  const removed = await plugin.post('delete', { id: 'yk-bad' })
  assert.equal(removed.status, 200)
  let stored = JSON.parse(await readFile(plugin.file, 'utf8'))
  assert.deepEqual(stored.presets.map((entry) => entry.id), ['yk-good'])

  const created = await plugin.post('create', { id: 'yk-new', name: '新的', plugins: [] })
  assert.equal(created.status, 200)
  stored = JSON.parse(await readFile(plugin.file, 'utf8'))
  assert.deepEqual(stored.presets.map((entry) => entry.id), ['yk-good', 'yk-new'])
})

test('create: without the settings service the write still lands', async (t) => {
  const plugin = await withPlugin(t, { noSettings: true })
  const created = await plugin.post('create', { id: 'yk-demo', name: '演示', plugins: [] })
  assert.equal(created.status, 200)
  assert.equal(plugin.emitted.length, 0)
  assert.ok(plugin.registered.has('yk-demo'))
})
