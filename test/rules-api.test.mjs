import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../host/rules/index.js'
import {
  ANCHOR_SENTINEL,
  HEAD_SENTINEL,
  RULES_ANCHOR_SECTION,
  RULES_SECTION,
} from '../host/rules/lib/render.js'

/** A context just real enough for `apply()`: sections, one assemble, one route. */
function createCtx({ workspaces, cwd }) {
  const sections = new Map()
  const routes = []
  const systemPrompt = {
    section(section) {
      sections.set(section.name, section)
      return () => sections.delete(section.name)
    },
    async assemble(context = {}) {
      // A `complete` section would be restored after the waterfall: model that.
      if (context.complete === true) {
        return { sections: [{ name: 'deployment:persona-prefix', text: 'ONLY' }], tools: [] }
      }
      const list = [...sections.values()]
        .sort((left, right) => left.order - right.order)
        .map((section) => ({
          name: section.name,
          text: typeof section.text === 'function' ? section.text(context) : section.text,
        }))
        .filter((section) => section.text !== '')
      return { sections: list, tools: [] }
    },
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    systemPrompt,
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      if (name === 'workingDirectory') return { get: (session) => session?.cwd ?? cwd }
      return undefined
    },
  }

  return { ctx, sections, routes, systemPrompt }
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

async function withPlugin(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yk-rules-home-'))
  const ws1 = await mkdtemp(path.join(os.tmpdir(), 'yk-rules-one-'))
  const ws2 = await mkdtemp(path.join(os.tmpdir(), 'yk-rules-two-'))
  const agentsHome = await mkdtemp(path.join(os.tmpdir(), 'yk-rules-agents-'))
  const previousHome = process.env.DSH_HOME
  const previousAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = agentsHome
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousAgents === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgents
    await rm(home, { recursive: true, force: true })
    await rm(ws1, { recursive: true, force: true })
    await rm(ws2, { recursive: true, force: true })
    await rm(agentsHome, { recursive: true, force: true })
  })
  const workspaces = [
    { id: 'ws1', title: 'One', path: ws1, sessionIds: ['s1'] },
    { id: 'ws2', title: 'Two', path: ws2, sessionIds: ['s2'] },
  ]
  const harness = createCtx({ workspaces, cwd: ws1 })
  apply(harness.ctx, { maxBytes: 16384, ...options })
  return { home, ws1, ws2, agentsHome, workspaces, ...harness }
}

const agentAt = (id, cwd) => ({ session: { id, cwd } })
const joined = (assembly) => assembly.sections.map((section) => section.text).join('\n')

test('apply: the two sections carry the designed orders and turn empties off', async (t) => {
  const { sections, systemPrompt, ws1 } = await withPlugin(t)
  assert.equal(sections.get(RULES_SECTION)?.order, -950)
  assert.equal(sections.get(RULES_ANCHOR_SECTION)?.order, 10400)

  const assembly = await systemPrompt.assemble({ agent: agentAt('s1', ws1) })
  assert.equal(joined(assembly), '')
})

test('apply: global and workspace files reach the same assembly, scoped per workspace', async (t) => {
  const { home, ws1, ws2, systemPrompt } = await withPlugin(t)
  await writeFile(path.join(home, 'rules.md'), 'GLOBAL-RULE')
  await writeFile(path.join(ws1, 'rules.md'), 'PROJECT-ONE')

  const one = await systemPrompt.assemble({ agent: agentAt('s1', ws1) })
  const oneText = joined(one)
  assert.match(oneText, /GLOBAL-RULE/u)
  assert.match(oneText, /PROJECT-ONE/u)
  assert.ok(oneText.includes(HEAD_SENTINEL))
  assert.ok(oneText.includes(ANCHOR_SENTINEL))

  const two = await systemPrompt.assemble({ agent: agentAt('s2', ws2) })
  const twoText = joined(two)
  assert.match(twoText, /GLOBAL-RULE/u)
  assert.doesNotMatch(twoText, /PROJECT-ONE/u)
})

test('http: saving a document applies to the very next assembly, without a restart', async (t) => {
  const { home, ws1, routes, systemPrompt } = await withPlugin(t)
  await writeFile(path.join(ws1, 'rules.md'), 'OLD-PROJECT')
  const agent = agentAt('s1', ws1)
  assert.match(joined(await systemPrompt.assemble({ agent })), /OLD-PROJECT/u)

  const saved = await call(routes[0], 'POST', '/rules/api/doc', { scope: 'global', text: 'NEW-GLOBAL' })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.doc.exists, true)
  assert.equal(await readFile(path.join(home, 'rules.md'), 'utf8'), 'NEW-GLOBAL')

  const after = joined(await systemPrompt.assemble({ agent }))
  assert.match(after, /NEW-GLOBAL/u)
  assert.match(after, /OLD-PROJECT/u)
})

test('http: switches disable one scope and are persisted', async (t) => {
  const { home, ws1, routes, systemPrompt } = await withPlugin(t)
  await writeFile(path.join(home, 'rules.md'), 'GLOBAL-RULE')
  await writeFile(path.join(ws1, 'rules.md'), 'PROJECT-ONE')
  const agent = agentAt('s1', ws1)

  const { json } = await call(routes[0], 'POST', '/rules/api/settings', { project: false })
  assert.equal(json.settings.project, false)
  const saved = JSON.parse(await readFile(path.join(home, 'rules-settings.json'), 'utf8'))
  assert.equal(saved.project, false)

  const text = joined(await systemPrompt.assemble({ agent }))
  assert.match(text, /GLOBAL-RULE/u)
  assert.doesNotMatch(text, /PROJECT-ONE/u)
})

test('http: reset removes a document and the next assembly drops it', async (t) => {
  const { home, routes, systemPrompt } = await withPlugin(t)
  await writeFile(path.join(home, 'rules.md'), 'GLOBAL-RULE')
  const agent = agentAt('s1', home)
  assert.match(joined(await systemPrompt.assemble({ agent })), /GLOBAL-RULE/u)

  const reset = await call(routes[0], 'POST', '/rules/api/reset', { scope: 'global' })
  assert.equal(reset.status, 200)
  assert.equal(reset.json.doc.exists, false)
  assert.equal(joined(await systemPrompt.assemble({ agent })), '')
})

test('http: the config lists both workspaces and the effective page state', async (t) => {
  const { ws1, routes } = await withPlugin(t)
  await writeFile(path.join(ws1, 'rules.md'), 'PROJECT-ONE')
  const { json } = await call(routes[0], 'GET', '/rules/api/config')
  assert.equal(json.ok, true)
  assert.equal(json.workspaces.length, 2)
  assert.equal(json.limits.maxBytes, 16384)
  const one = json.workspaces.find((workspace) => workspace.id === 'ws1')
  assert.equal(one.exists, true)
  assert.equal(one.filePath, path.join(ws1, 'rules.md'))
})

test('http: unknown workspaces, oversized documents and symlink targets are refused', async (t) => {
  const { ws2, home, routes } = await withPlugin(t)

  const unknown = await call(routes[0], 'GET', '/rules/api/doc?scope=workspace&id=nope')
  assert.equal(unknown.status, 400)
  assert.match(unknown.json.error, /未知的工作区/u)

  const huge = await call(routes[0], 'POST', '/rules/api/doc', { scope: 'global', text: 'x'.repeat(16385) })
  assert.equal(huge.status, 400)
  assert.match(huge.json.error, /超过单份上限/u)

  const outside = await mkdtemp(path.join(os.tmpdir(), 'yk-rules-out-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(path.join(outside, 'secret.md'), 'secret')
  await symlink(path.join(outside, 'secret.md'), path.join(ws2, 'rules.md'))
  const refused = await call(routes[0], 'POST', '/rules/api/doc', { scope: 'workspace', id: 'ws2', text: 'x' })
  assert.equal(refused.status, 400)
  assert.match(refused.json.error, /符号链接/u)
})

test('http: import reads the first existing AGENTS.md candidate without writing', async (t) => {
  const { ws1, routes } = await withPlugin(t)
  await writeFile(path.join(ws1, 'AGENTS.md'), 'IMPORTED-RULES')
  const { json } = await call(routes[0], 'GET', '/rules/api/import?scope=workspace&id=ws1')
  assert.equal(json.ok, true)
  assert.equal(json.source, path.join(ws1, 'AGENTS.md'))
  assert.equal(json.text, 'IMPORTED-RULES')
  assert.ok(json.candidates.some((candidate) => candidate.path.endsWith('AGENTS.md') && candidate.exists))

  await mkdir(path.join(ws1, 'sub'), { recursive: true })
  const empty = await call(routes[0], 'GET', '/rules/api/import?scope=workspace&id=ws2')
  assert.equal(empty.json.source, null)
})

test('http: the probe assembles the live session and does not move the stats', async (t) => {
  const { ws1, routes, systemPrompt, ctx } = await withPlugin(t)
  await writeFile(path.join(ws1, 'rules.md'), 'PROJECT-ONE')
  const agent = agentAt('s1', ws1)
  await systemPrompt.assemble({ agent })
  ctx.agents = { list: () => [agent] }

  const before = (await call(routes[0], 'GET', '/rules/api/config')).json.stats.assembled
  const { json } = await call(routes[0], 'GET', '/rules/api/probe')
  assert.equal(json.ok, true)
  assert.equal(json.hasHead, true)
  assert.equal(json.hasAnchor, true)
  assert.ok(json.projectPath.endsWith('rules.md'))
  assert.deepEqual(json.workspace, { id: 'ws1', title: 'One', path: ws1 })
  const after = (await call(routes[0], 'GET', '/rules/api/config')).json.stats.assembled
  assert.equal(after, before)

  const missing = await call(routes[0], 'GET', '/rules/api/probe?sessionId=nope')
  assert.equal(missing.json.ok, false)
  assert.equal(missing.json.reason, 'not-live')
})

test('apply: the backstop restores both sections after a complete prompt', async (t) => {
  const { ws1, systemPrompt } = await withPlugin(t)
  await writeFile(path.join(ws1, 'rules.md'), 'PROJECT-ONE')
  const assembly = await systemPrompt.assemble({ agent: agentAt('s1', ws1), complete: true })
  const names = assembly.sections.map((section) => section.name)
  assert.ok(names.includes('deployment:persona-prefix'))
  assert.ok(names.includes(RULES_SECTION))
  assert.ok(names.includes(RULES_ANCHOR_SECTION))
  assert.equal(names[0], RULES_SECTION)
  assert.equal(names.at(-1), RULES_ANCHOR_SECTION)
  assert.match(joined(assembly), /PROJECT-ONE/u)
})

test('apply: a session without a cwd still receives the global constraint', async (t) => {
  const { home, systemPrompt } = await withPlugin(t)
  await writeFile(path.join(home, 'rules.md'), 'GLOBAL-ONLY')
  const assembly = await systemPrompt.assemble({ agent: { session: { id: 's-nocwd' } } })
  const text = joined(assembly)
  assert.match(text, /GLOBAL-ONLY/u)
  assert.doesNotMatch(text, /## 工作区约束/u)
})

test('http: the probe picks the first live session when nothing was seen yet', async (t) => {
  const { ws1, routes, ctx } = await withPlugin(t)
  await writeFile(path.join(ws1, 'rules.md'), 'PROJECT-ONE')
  ctx.agents = { list: () => [agentAt('s1', ws1)] }
  const { json } = await call(routes[0], 'GET', '/rules/api/probe')
  assert.equal(json.ok, true)
  assert.equal(json.hasHead, true)
  assert.equal(json.sessionId, 's1')
})

test('apply: an external edit is picked up by the next assembly', async (t) => {
  const { home, ws1, systemPrompt } = await withPlugin(t)
  await writeFile(path.join(home, 'rules.md'), 'FIRST-VERSION')
  const agent = agentAt('s1', ws1)
  assert.match(joined(await systemPrompt.assemble({ agent })), /FIRST-VERSION/u)

  await writeFile(path.join(home, 'rules.md'), 'SECOND-VERSION-DIFFERENT')
  const after = joined(await systemPrompt.assemble({ agent }))
  assert.match(after, /SECOND-VERSION-DIFFERENT/u)
  assert.doesNotMatch(after, /FIRST-VERSION/u)
})
