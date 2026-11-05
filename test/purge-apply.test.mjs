import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

async function withPlugin(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yukari-purge-apply-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  const harness = createCtx()
  apply(harness.ctx, {})
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
  const saved = JSON.parse(await readFile(path.join(home, 'yukari-purge-settings.json'), 'utf8'))
  assert.equal(saved.anchor, false)
})

test('http: the prompt editor stores the custom prompt and reset restores the default', async (t) => {
  const { routes, home, systemPrompt } = await withPlugin(t)
  await call(routes[0], 'POST', '/purge/api/config', { prompt: 'CUSTOM RULES' })
  assert.equal(await readFile(path.join(home, 'yukari-purge-prompt.md'), 'utf8'), 'CUSTOM RULES')

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

  const { json } = await call(routes[0], 'GET', '/purge/api/probe', undefined)
  assert.equal(json.ok, true)
  assert.equal(json.hasInject, true)
  assert.equal(json.hasAnchor, true)
  assert.ok(json.sections.includes(PURGE_SECTION))
})

test('http: the probe explains itself when nothing is live', async (t) => {
  const { routes, ctx } = await withPlugin(t)
  ctx.agents = { get: () => undefined, list: () => [] }
  const { json } = await call(routes[0], 'GET', '/purge/api/probe?sessionId=nope', undefined)
  assert.equal(json.ok, false)
  assert.equal(json.reason, 'not-live')
})
