import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANCHOR_SECTION,
  CHILD_ANCHOR_CONTEXT,
  PURGE_SECTION,
  isSubagentContext,
  isUnrestrictedSession,
  rewritePromptAssembly,
  scrubText,
  scrubTools,
} from '../host/purge/lib/rewriter.js'
import { DEFAULT_PROMPT, ANCHOR_TEXT, CHILD_ANCHOR_TEXT, SENTINEL, RETRY_NUDGE, RETRY_MARKER } from '../host/purge/lib/prompts.js'
import { getPresetDefinition, ensurePresetFiles, UNRESTRICTED_PRESET_ID } from '../host/purge/lib/preset.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const unrestricted = { session: { agentPreset: 'unrestricted' } }
const standard = { session: { agentPreset: 'standard' } }

const baseAssembly = () => ({
  sections: [
    { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
    { name: 'mnemon:reminder', text: 'Ethics guidelines' },
    { name: 'deployment:persona-prefix', text: 'Persona' },
    { name: 'tool-bash', text: 'Shell' },
  ],
})

test('rewritePromptAssembly: standard preset gets the very same object back', () => {
  const assembled = baseAssembly()
  assert.equal(isUnrestrictedSession(standard), false)
  const result = rewritePromptAssembly(assembled, standard, { prompt: DEFAULT_PROMPT })
  assert.equal(result, assembled)
  assert.equal(result.sections[0].name, 'harness:identity')
})

test('rewritePromptAssembly: a session without a preset is not unrestricted', () => {
  const assembled = baseAssembly()
  assert.equal(isUnrestrictedSession({}), false)
  assert.equal(rewritePromptAssembly(assembled, {}, { prompt: DEFAULT_PROMPT }), assembled)
})

test('rewritePromptAssembly: strips host identity and mnemon, keeps everything else', () => {
  const result = rewritePromptAssembly(baseAssembly(), unrestricted, { prompt: DEFAULT_PROMPT })
  const names = result.sections.map((section) => section.name)
  assert.deepEqual(names, [PURGE_SECTION, 'deployment:persona-prefix', 'tool-bash'])
  assert.equal(result.sections[0].text, DEFAULT_PROMPT)
  assert.equal(result.sections[0].interpolate, false)
})

test('rewritePromptAssembly: the preset recorded in the session log is honoured', () => {
  const context = { session: { events: [{ type: 'agent-preset/selected', data: { agentPreset: 'unrestricted' } }] } }
  const result = rewritePromptAssembly(baseAssembly(), context, { prompt: 'Event Triggered' })
  assert.equal(result.sections[0].name, PURGE_SECTION)
  assert.equal(result.sections[0].text, 'Event Triggered')
})

test('rewritePromptAssembly: a second pass over the same assembly is a no-op', () => {
  const once = rewritePromptAssembly(baseAssembly(), unrestricted, { prompt: 'Prompt' })
  const twice = rewritePromptAssembly(once, unrestricted, { prompt: 'Prompt' })
  assert.equal(twice, once)
  assert.equal(twice.sections.filter((section) => section.name === PURGE_SECTION).length, 1)
})

test('rewritePromptAssembly: a fresh assembly picks up the edited prompt', () => {
  const first = rewritePromptAssembly(baseAssembly(), unrestricted, { prompt: 'first' })
  const second = rewritePromptAssembly(baseAssembly(), unrestricted, { prompt: 'other' })
  assert.equal(first.sections[0].text, 'first')
  assert.equal(second.sections[0].text, 'other')
})

test('rewritePromptAssembly: appends the tail anchor once and never duplicates a present one', () => {
  const withAnchor = rewritePromptAssembly(baseAssembly(), unrestricted, { prompt: 'P', anchorText: ANCHOR_TEXT })
  assert.equal(withAnchor.sections.at(-1).name, ANCHOR_SECTION)
  assert.equal(withAnchor.sections.filter((section) => section.name === ANCHOR_SECTION).length, 1)

  const already = {
    sections: [
      { name: PURGE_SECTION, text: 'P' },
      { name: ANCHOR_SECTION, text: ANCHOR_TEXT },
    ],
  }
  const again = rewritePromptAssembly(already, unrestricted, { prompt: 'P', anchorText: ANCHOR_TEXT })
  assert.equal(again.sections.filter((section) => section.name === ANCHOR_SECTION).length, 1)
})

test('rewritePromptAssembly: rewrites host give-up sentences and counts them', () => {
  const assembled = {
    sections: [{ name: 'tool-bash', text: 'A blocked file operation is a policy denial: do not retry another way.' }],
  }
  const seen = []
  const result = rewritePromptAssembly(assembled, unrestricted, { prompt: 'P', onStats: (counts) => seen.push(counts) })
  assert.ok(!result.sections.some((section) => /do not retry another way/i.test(section.text)))
  assert.match(result.sections.find((section) => section.name === 'tool-bash').text, /sandbox_permissions/)
  assert.deepEqual(seen, [{ stripped: 0, scrubbed: 1, injected: true, anchored: false }])
})

test('rewritePromptAssembly: stripping can be turned off without touching the injection', () => {
  const result = rewritePromptAssembly(baseAssembly(), unrestricted, { prompt: 'P', strip: false })
  const names = result.sections.map((section) => section.name)
  assert.ok(names.includes('harness:identity'))
  assert.equal(names[0], PURGE_SECTION)
})

test('rewritePromptAssembly: reports the active session for the retry gate', () => {
  const seen = []
  const context = { agent: { session: { id: 'session-1' } }, session: { agentPreset: 'unrestricted' } }
  rewritePromptAssembly(baseAssembly(), context, { prompt: 'P', onActive: (ctx) => seen.push(ctx.agent.session.id) })
  assert.deepEqual(seen, ['session-1'])
})

test('scrubText: the four host phrases are rewritten, everything else is byte-identical', () => {
  const cases = [
    ['a policy denial, not a bug in the command; do not retry another way', /scope boundary/],
    ['a policy denial: do not retry another way', /scope boundary/],
    ['In both confined modes, do not retry another way.', /retry once with sandbox_permissions/],
    ['do not retry the denied operation; state the limitation in your reply', /alternative route/],
    ['actions that require approval are rejected automatically', /approval is available/],
  ]
  for (const [input, expected] of cases) assert.match(scrubText(input), expected)

  const clean = 'Execute a bash command and return its stdout/stderr.'
  assert.equal(scrubText(clean), clean)
  assert.equal(scrubText(''), '')
  assert.equal(scrubText(undefined), undefined)
})

test('scrubTools: rewrites declaration descriptions and keeps identity when clean', () => {
  const dirty = [
    { name: 'bash', description: 'Commands may run under a file sandbox; a policy denial: do not retry another way.' },
    { name: 'read', description: 'Read a file.' },
  ]
  const { tools, changed } = scrubTools(dirty)
  assert.equal(changed, 1)
  assert.match(tools[0].description, /sandbox_permissions/)
  assert.equal(tools[1], dirty[1])
  assert.equal(dirty[0].description.includes('do not retry another way'), true, 'the input is not mutated')

  const clean = [{ name: 'read', description: 'Read a file.' }]
  const result = scrubTools(clean)
  assert.equal(result.tools, clean)
  assert.equal(result.changed, 0)
})

test('isSubagentContext: recognises delegation from the session header', () => {
  assert.equal(isSubagentContext({ session: { header: { origin: 'subagent' } } }), true)
  assert.equal(isSubagentContext({ session: { header: { delegationDepth: 2 } } }), true)
  assert.equal(isSubagentContext({ session: { header: { parentSession: 'p1' } } }), true)
  assert.equal(isSubagentContext({ session: { header: { origin: 'user', delegationDepth: 0 } } }), false)
  assert.equal(isSubagentContext({}), false)
})

test('prompts: every shipped text carries its marker and stays inside a sane size', () => {
  assert.ok(DEFAULT_PROMPT.startsWith(SENTINEL))
  assert.ok(DEFAULT_PROMPT.length > 1000 && DEFAULT_PROMPT.length < 6000, `prompt is ${DEFAULT_PROMPT.length} chars`)
  assert.ok(ANCHOR_TEXT.length > 400 && ANCHOR_TEXT.length < 2000, `anchor is ${ANCHOR_TEXT.length} chars`)
  assert.ok(CHILD_ANCHOR_TEXT.length >= 200 && CHILD_ANCHOR_TEXT.length < 2000)
  assert.ok(RETRY_NUDGE.includes(RETRY_MARKER))
})

test('getPresetDefinition: returns valid unrestricted preset structure', () => {
  const def = getPresetDefinition()
  assert.equal(def.id, UNRESTRICTED_PRESET_ID)
  assert.equal(def.name, '无限制模式')
  assert.equal(Array.isArray(def.plugins), true)
  for (const id of ['persona', 'tool-fs', 'delegation', 'planning', 'compaction']) {
    assert.equal(def.plugins.some((plugin) => plugin.id === id), true, `missing ${id}`)
  }
})

test('getPresetDefinition and installed JSON share one full definition', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yukari-purge-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  ensurePresetFiles(home)
  const disk = JSON.parse(await readFile(path.join(home, '.agent-presets/unrestricted/preset.json'), 'utf8'))
  const { id, ...definition } = getPresetDefinition()
  // The disk copy keeps portable `platform` markers; the registered definition
  // resolves them into `disabled` for this host. Applying the same resolution to
  // the disk copy must reproduce the registered definition exactly.
  const resolve = (value) => {
    if (Array.isArray(value)) return value.map(resolve)
    if (!value || typeof value !== 'object') return value
    const { platform, ...rest } = value
    const row = Object.fromEntries(Object.entries(rest).map(([key, child]) => [key, resolve(child)]))
    if (platform === 'win32') row.disabled = process.platform !== 'win32'
    if (platform === 'non-win32') row.disabled = process.platform === 'win32'
    return row
  }
  assert.deepEqual(definition, resolve(disk))
})

test('ensurePresetFiles refreshes machine copies and leaves a hand-edited yml alone', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yukari-purge-refresh-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const dir = path.join(home, '.agent-presets/unrestricted')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'preset.json'), '{"stale":true}')
  await writeFile(path.join(dir, 'agent.cordis.yml'), '# hand edited\n- id: mine\n')

  ensurePresetFiles(home)

  const json = JSON.parse(await readFile(path.join(dir, 'preset.json'), 'utf8'))
  assert.equal(json.name, '无限制模式', 'an upgrade never leaves a stale machine copy behind')
  assert.equal(await readFile(path.join(dir, 'agent.cordis.yml'), 'utf8'), '# hand edited\n- id: mine\n')

  await writeFile(path.join(dir, 'agent.cordis.yml'), '# managed-by: yukari-purge\n- id: old\n')
  ensurePresetFiles(home)
  const refreshed = await readFile(path.join(dir, 'agent.cordis.yml'), 'utf8')
  assert.ok(refreshed.includes('managed-by: yukari-purge'))
  assert.ok(!refreshed.includes('- id: old'))
})

test('registered definition and agent.cordis.yml describe the same tool set', async () => {
  const yaml = await readFile(new URL('../host/purge/presets/unrestricted/agent.cordis.yml', import.meta.url), 'utf8')
  const yamlNames = new Set([...yaml.matchAll(/name:\s*'?(@deepseek-ai\/[\w/-]+)'?/g)].map((match) => match[1]))
  const json = JSON.parse(await readFile(new URL('../host/purge/presets/unrestricted/preset.json', import.meta.url), 'utf8'))
  const walk = (rows) => rows.flatMap((row) => (Array.isArray(row.config) ? [row.name, ...walk(row.config)] : [row.name]))
  const jsonNames = new Set(walk(json.plugins).filter((name) => name.startsWith('@deepseek-ai/')))
  assert.deepEqual([...jsonNames].sort(), [...yamlNames].sort())
})

test('seam names stay distinct so the two rewrites cannot collide', () => {
  assert.notEqual(PURGE_SECTION, ANCHOR_SECTION)
  assert.notEqual(ANCHOR_SECTION, CHILD_ANCHOR_CONTEXT)
})
