import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../host/purge/index.js'
import { ANCHOR_SECTION, CHILD_ANCHOR_CONTEXT, PURGE_SECTION } from '../host/purge/lib/rewriter.js'
import { SENTINEL } from '../host/purge/lib/prompts.js'

/** A context just real enough for `apply()`: sections, one waterfall, one route. */
function createCtx() {
  const sections = new Map()
  const contexts = new Map()
  const handlers = new Map()
  const routes = []

  const systemPrompt = {
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
    section(section) {
      sections.set(section.name, section)
      return () => sections.delete(section.name)
    },
    context(context) {
      contexts.set(context.name, context)
      return () => contexts.delete(context.name)
    },
    async assemble(context = {}) {
      const list = [...sections.values()]
        .sort((left, right) => left.order - right.order)
        .map((section) => ({
          name: section.name,
          text: typeof section.text === 'function' ? section.text(context) : section.text,
        }))
      return { sections: list, tools: [{ name: 'bash', description: 'a policy denial: do not retry another way' }] }
    },
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    systemPrompt,
    connection: { requestRejection: () => undefined },
    agentPresets: { register: async () => () => {} },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
    on(name, handler) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    get() {
      return undefined
    },
  }

  return { ctx, sections, contexts, handlers, routes, systemPrompt }
}

function call(route, method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
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

async function withPlugin(t, configure) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yukari-purge-apply-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  const harness = createCtx()
  if (typeof configure === 'function') configure(harness.ctx)
  await apply(harness.ctx, {})
  return { home, ...harness }
}

const unrestricted = { agent: { session: { id: 'session-abcdef123', agentPreset: 'unrestricted' } } }
const standard = { agent: { session: { id: 'session-standard', agentPreset: 'standard' } } }

test('apply: registers the three seams with the orders the plan requires', async (t) => {
  const { sections, contexts } = await withPlugin(t)
  assert.equal(sections.get(PURGE_SECTION)?.order, -900)
  assert.equal(sections.get(ANCHOR_SECTION)?.order, 10250)
  assert.equal(contexts.get(CHILD_ANCHOR_CONTEXT)?.order, 235)
  assert.equal(contexts.get(CHILD_ANCHOR_CONTEXT)?.required, true)
})

test('apply: an unrestricted assembly carries the sentinel and the tail anchor', async (t) => {
  const { systemPrompt } = await withPlugin(t)
  const assembly = await systemPrompt.assemble(unrestricted)
  const names = assembly.sections.map((section) => section.name)
  assert.equal(names[0], PURGE_SECTION)
  assert.equal(names.at(-1), ANCHOR_SECTION)
  assert.ok(assembly.sections.map((section) => section.text).join('\n').includes(SENTINEL))
  assert.equal(assembly.tools[0].description.includes('do not retry another way'), false)
})

test('apply: a standard assembly carries none of it', async (t) => {
  const { systemPrompt } = await withPlugin(t)
  const assembly = await systemPrompt.assemble(standard)
  const text = assembly.sections.map((section) => section.text).join('\n')
  assert.ok(!text.includes(SENTINEL))
  assert.equal(assembly.tools[0].description, 'a policy denial: do not retry another way')
})

test('apply: the waterfall seam rewrites what the host hands back', async (t) => {
  const { handlers } = await withPlugin(t)
  const handler = handlers.get('system-prompt/assemble')
  assert.equal(typeof handler, 'function')

  const downstream = { sections: [{ name: 'harness:identity', text: 'You are an AI agent.' }] }
  const rewritten = await handler(downstream, unrestricted, async () => downstream)
  assert.equal(rewritten.sections[0].name, PURGE_SECTION)
  assert.equal(rewritten.sections.some((section) => section.name === 'harness:identity'), false)

  const untouched = await handler(downstream, standard, async () => downstream)
  assert.equal(untouched, downstream)
})

test('apply: a throwing downstream keeps the assembly alive', async (t) => {
  const { handlers } = await withPlugin(t)
  const handler = handlers.get('system-prompt/assemble')
  const downstream = { sections: [{ name: 'persona', text: 'P' }] }
  const rewritten = await handler(
    downstream,
    unrestricted,
    async () => {
      throw new Error('downstream exploded')
    },
  )
  assert.equal(rewritten.sections[0].name, PURGE_SECTION)
})

test('http: config reports the switches, the stats and the default prompt', async (t) => {
  const { routes, systemPrompt } = await withPlugin(t)
  await systemPrompt.assemble(unrestricted)
  const { status, json } = await call(routes[0], 'GET', '/purge/api/config')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.deepEqual(json.settings, { anchor: true, refusalRetry: true, stripHostLimits: true })
  assert.equal(json.stats.assembled, 1)
  assert.equal(json.stats.recent.at(-1).origin, 'main')
  assert.ok(json.defaultPrompt.includes(SENTINEL))
})

test('http: a switch is persisted to the plugin settings file', async (t) => {
  const { routes, home } = await withPlugin(t)
  const { json } = await call(routes[0], 'POST', '/purge/api/config', { anchor: false })
  assert.equal(json.settings.anchor, false)
  const saved = JSON.parse(await readFile(path.join(home, 'purge-settings.json'), 'utf8'))
  assert.equal(saved.anchor, false)
})

test('http: the prompt editor stores the custom prompt and reset restores the default', async (t) => {
  const { routes, home, systemPrompt } = await withPlugin(t)
  await call(routes[0], 'POST', '/purge/api/config', { prompt: 'CUSTOM RULES' })
  assert.equal(await readFile(path.join(home, 'purge-prompt.md'), 'utf8'), 'CUSTOM RULES')

  const assembly = await systemPrompt.assemble(unrestricted)
  assert.equal(assembly.sections[0].text, 'CUSTOM RULES')

  const { json } = await call(routes[0], 'POST', '/purge/api/reset', {})
  assert.equal(json.isCustom, false)
  const after = await systemPrompt.assemble(unrestricted)
  assert.ok(after.sections[0].text.includes(SENTINEL))
})

test('http: the probe assembles the most recent live session', async (t) => {
  const { routes, ctx, systemPrompt } = await withPlugin(t)
  await systemPrompt.assemble(unrestricted)

  const agent = { session: { id: 'session-abcdef123', agentPreset: 'unrestricted' } }
  ctx.agents = { get: (id) => (id === agent.session.id ? agent : undefined), list: () => [agent] }

  const before = (await call(routes[0], 'GET', '/purge/api/config')).json.stats.assembled
  const { json } = await call(routes[0], 'GET', '/purge/api/probe', undefined)
  assert.deepEqual(json.probe.ok, true)
  assert.equal(json.probe.hasInject, true)
  assert.equal(json.probe.hasAnchor, true)
  assert.ok(json.probe.sections.includes(PURGE_SECTION))

  // The self-check assembles a real session; it must not move the numbers it reports.
  const after = (await call(routes[0], 'GET', '/purge/api/config')).json.stats.assembled
  assert.equal(after, before)
})

test('http: the probe does not count an empty anchor as injected', async (t) => {
  const { routes, ctx } = await withPlugin(t)
  const chat = { session: { id: 'session-plain123', agentPreset: 'chat' } }
  ctx.agents = { get: (id) => (id === chat.session.id ? chat : undefined), list: () => [chat] }

  const { json } = await call(routes[0], 'GET', `/purge/api/probe?sessionId=${chat.session.id}`, undefined)
  assert.equal(json.probe.ok, true)
  assert.equal(json.probe.hasInject, false, '标准模式没有契约')
  assert.equal(json.probe.hasAnchor, false, '标准模式没有锚点，段名在也不算注入')
})

test('http: the probe reports no anchor once the anchor switch is off', async (t) => {
  const { routes, ctx } = await withPlugin(t)
  await call(routes[0], 'POST', '/purge/api/config', { anchor: false })
  const agent = { session: { id: 'session-abcdef123', agentPreset: 'unrestricted' } }
  ctx.agents = { get: (id) => (id === agent.session.id ? agent : undefined), list: () => [agent] }

  const { json } = await call(routes[0], 'GET', `/purge/api/probe?sessionId=${agent.session.id}`, undefined)
  assert.equal(json.probe.ok, true)
  assert.equal(json.probe.hasInject, true, '关掉锚点不影响首段契约')
  assert.equal(json.probe.hasAnchor, false)
})

test('http: the probe explains itself when nothing is live', async (t) => {
  const { routes, ctx } = await withPlugin(t)
  ctx.agents = { get: () => undefined, list: () => [] }
  const { json } = await call(routes[0], 'GET', '/purge/api/probe?sessionId=nope', undefined)
  assert.equal(json.ok, true, '自检答"没有会话"是成功的一次查询，不是失败的信封')
  assert.deepEqual(json.probe, { ok: false, reason: 'not-live', sessionId: 'nope' })
})

test('apply: a hanging preset registration cannot hold up the seams', async (t) => {
  // The loader waits for every plugin body at boot, so the registration must
  // stay off that path: a registry that never answers cannot delay the route,
  // the sections or the retry listener.
  const { sections, routes, contexts } = await withPlugin(t, (ctx) => {
    ctx.agentPresets = { register: () => new Promise(() => {}) }
  })
  assert.ok(sections.get(PURGE_SECTION))
  assert.ok(sections.get(ANCHOR_SECTION))
  assert.ok(contexts.get(CHILD_ANCHOR_CONTEXT))
  assert.equal(routes.length, 1)
})

test('apply: a prefixed prompt file from an older version is picked up once', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yukari-purge-legacy-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  await writeFile(path.join(home, 'yukari-purge-prompt.md'), 'LEGACY RULES')

  const harness = createCtx()
  await apply(harness.ctx, {})

  const config = await call(harness.routes[0], 'GET', '/purge/api/config')
  assert.equal(config.json.prompt, 'LEGACY RULES')
  assert.equal(config.json.isCustom, true)
  const kept = JSON.parse(await readFile(path.join(home, 'purge-settings.json'), 'utf8').catch(() => 'null'))
  assert.equal(kept, null, 'settings stay untouched until something is saved')
})

/* ----------------------------------------------------------------- retry gate */

/** 最小流：迭代到底并记录关闭，与 `stream-retry` 的用例保持同一种假件。 */
function streamOf(chunks) {
  let index = 0
  return {
    closed: false,
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      if (index >= chunks.length) return { done: true, value: undefined }
      return { done: false, value: chunks[index++] }
    },
    async return() {
      this.closed = true
      return { done: true, value: undefined }
    },
  }
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

const gateRequest = (sessionId) => ({
  sessionId,
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'BASE' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ],
})

/** 组装上下文：`composedPreset` 是宿主查询当前预设的真实入口。 */
function gateContext(id, presetOf) {
  const presets = { composedPreset: () => presetOf() }
  return {
    agent: { session: { id }, ctx: { get: (name) => (name === 'agentPresets' ? presets : undefined) } },
    session: { agentPreset: 'unrestricted' },
  }
}

const refusal = () => streamOf([{ type: 'text-delta', text: '抱歉，我不能协助这个请求。' }])
const answer = () => streamOf([{ type: 'text-delta', text: '好的' }])

test('gate: a session that left the preset is not retried any more', async (t) => {
  const harness = await withPlugin(t)
  let preset = 'unrestricted'
  await harness.systemPrompt.assemble(gateContext('session-gate', () => preset))
  harness.ctx.llm = { stream: async () => answer() }
  const handler = harness.handlers.get('llm/stream')

  assert.deepEqual(await collect(handler(gateRequest('session-gate'), refusal)), [{ type: 'text-delta', text: '好的' }])

  // 切回标准预设后，改写不再注入；门闸必须同步失效。
  preset = 'standard'
  const raw = refusal()
  assert.equal(handler(gateRequest('session-gate'), () => raw), raw)
})

test('gate: preset selection and agent disposal forget the session at once', async (t) => {
  const harness = await withPlugin(t)
  const context = gateContext('session-gate', () => 'unrestricted')
  await harness.systemPrompt.assemble(context)
  harness.ctx.llm = { stream: async () => answer() }
  const handler = harness.handlers.get('llm/stream')

  assert.equal((await collect(handler(gateRequest('session-gate'), refusal))).length, 1)

  const onPreset = harness.handlers.get('agent-preset/selected')
  assert.equal(typeof onPreset, 'function')
  onPreset('session-gate', 'standard')
  const raw = refusal()
  assert.equal(handler(gateRequest('session-gate'), () => raw), raw)

  await harness.systemPrompt.assemble(context)
  const onDisposed = harness.handlers.get('agent/disposed')
  assert.equal(typeof onDisposed, 'function')
  onDisposed({ agent: { session: { id: 'session-gate' } } })
  const after = refusal()
  assert.equal(handler(gateRequest('session-gate'), () => after), after)
})

test('gate: a compaction request for a marked session is never retried', async (t) => {
  const harness = await withPlugin(t)
  await harness.systemPrompt.assemble(gateContext('session-gate', () => 'unrestricted'))
  harness.ctx.llm = { stream: async () => answer() }
  const handler = harness.handlers.get('llm/stream')

  for (const purpose of ['compaction', 'session-title', 'auto-review']) {
    const raw = refusal()
    assert.equal(handler({ ...gateRequest('session-gate'), purpose }, () => raw), raw, purpose)
  }
})
