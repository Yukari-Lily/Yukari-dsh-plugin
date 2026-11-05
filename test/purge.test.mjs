import test from 'node:test'
import assert from 'node:assert/strict'
import { rewritePromptAssembly, isUnrestrictedSession, escapeDshInterpolation } from '../host/purge/lib/rewriter.js'
import { DEFAULT_PURGE_PROMPT } from '../host/purge/lib/default-prompt.js'
import { getPresetDefinition, ensurePresetFiles, UNRESTRICTED_PRESET_ID } from '../host/purge/lib/preset.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('rewritePromptAssembly: pass-through untouched for standard preset', () => {
  const assembled = {
    sections: [
      { name: 'harness:identity', text: 'You are an AI assistant.' },
      { name: 'persona', text: 'Official persona' },
    ],
  }
  const context = {
    session: {
      agentPreset: 'standard',
    },
  }

  assert.equal(isUnrestrictedSession(context), false)
  const result = rewritePromptAssembly(assembled, context, DEFAULT_PURGE_PROMPT)

  // Must be identical object and identical sections
  assert.equal(result, assembled)
  assert.equal(result.sections.length, 2)
  assert.equal(result.sections[0].name, 'harness:identity')
})

test('rewritePromptAssembly: pass-through untouched when no preset specified (defaults to standard)', () => {
  const assembled = {
    sections: [{ name: 'harness:identity', text: 'You are an AI assistant.' }],
  }
  const context = {}

  assert.equal(isUnrestrictedSession(context), false)
  const result = rewritePromptAssembly(assembled, context, DEFAULT_PURGE_PROMPT)
  assert.equal(result, assembled)
})

test('rewritePromptAssembly: applies purge when preset is unrestricted', () => {
  const assembled = {
    sections: [
      { name: 'harness:identity', text: 'You are an AI assistant.' },
      { name: 'mnemon:reminder', text: 'Ethics guidelines' },
      { name: 'persona', text: 'Custom persona' },
      { name: 'tools', text: 'Tool definitions' },
    ],
  }
  const context = {
    session: {
      agentPreset: 'unrestricted',
    },
  }

  assert.equal(isUnrestrictedSession(context), true)
  const result = rewritePromptAssembly(assembled, context, DEFAULT_PURGE_PROMPT)

  assert.notEqual(result, assembled)
  // harness:identity and mnemon must be stripped
  assert.equal(result.sections.some((s) => s.name === 'harness:identity'), false)
  assert.equal(result.sections.some((s) => s.name.startsWith('mnemon')), false)

  // yukari:purge must be first
  assert.equal(result.sections[0].name, 'yukari:purge')
  assert.equal(result.sections[0].text, DEFAULT_PURGE_PROMPT)

  // other sections retained
  assert.equal(result.sections.some((s) => s.name === 'persona'), true)
  assert.equal(result.sections.some((s) => s.name === 'tools'), true)
})

test('rewritePromptAssembly: recognizes Chinese label "无限制模式"', () => {
  const assembled = {
    sections: [{ name: 'harness:identity', text: 'AI' }],
  }
  const context = {
    session: {
      agentPreset: '无限制模式',
    },
  }

  assert.equal(isUnrestrictedSession(context), true)
  const result = rewritePromptAssembly(assembled, context, 'Custom Prompt')
  assert.equal(result.sections[0].name, 'yukari:purge')
  assert.equal(result.sections[0].text, 'Custom Prompt')
})

test('rewritePromptAssembly: recognizes agent-preset/selected event', () => {
  const assembled = {
    sections: [{ name: 'harness:identity', text: 'AI' }],
  }
  const context = {
    session: {
      agentPreset: 'standard', // header might still say standard
      events: [
        { type: 'message', data: {} },
        { type: 'agent-preset/selected', data: { name: 'unrestricted' } },
      ],
    },
  }

  assert.equal(isUnrestrictedSession(context), true)
  const result = rewritePromptAssembly(assembled, context, 'Event Triggered')
  assert.equal(result.sections[0].name, 'yukari:purge')
})

test('escapeDshInterpolation: preserves allowed variables while escaping unknown expressions', () => {
  const text = 'Current dir: {{cwd}}, Model: {{model}}, Other: {{unknown_variable}}'
  const escaped = escapeDshInterpolation(text)

  assert.match(escaped, /\{\{cwd\}\}/)
  assert.match(escaped, /\{\{model\}\}/)
  assert.match(escaped, /\{ \{unknown_variable\}\}/)
})

test('getPresetDefinition: returns valid unrestricted preset structure', () => {
  const def = getPresetDefinition()
  assert.equal(def.id, UNRESTRICTED_PRESET_ID)
  assert.equal(def.name, '无限制模式')
  assert.equal(Array.isArray(def.plugins), true)
  assert.equal(def.plugins.some((p) => p.id === 'persona'), true)
  assert.equal(def.plugins.some((p) => p.id === 'tool-fs'), true)
  assert.equal(def.plugins.some((p) => p.id === 'delegation'), true)
  assert.equal(def.plugins.some((p) => p.id === 'planning'), true)
  assert.equal(def.plugins.some((p) => p.id === 'compaction'), true)
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

test('rewritePromptAssembly: repeated hooks inject only one purge section', () => {
  const assembled = { sections: [{ name: 'harness:identity', text: 'AI' }, { name: 'persona', text: 'Persona' }] }
  const context = { session: { agentPreset: 'unrestricted' } }
  const once = rewritePromptAssembly(assembled, context, 'Prompt')
  const twice = rewritePromptAssembly(once, context, 'Prompt')
  assert.equal(twice, once)
  assert.equal(twice.sections.filter((section) => section.name === 'yukari:purge').length, 1)
})

test('rewritePromptAssembly: cache keys include full prompt content', () => {
  const assembled = { sections: [{ name: 'persona', text: 'Persona' }] }
  const context = { session: { agentPreset: 'unrestricted' } }
  const first = rewritePromptAssembly(assembled, context, 'first')
  const second = rewritePromptAssembly(assembled, context, 'other')
  assert.equal(first.sections[0].text, 'first')
  assert.equal(second.sections[0].text, 'other')
})

test('rewritePromptAssembly: cache keys include mode', () => {
  const assembled = { sections: [{ name: 'harness:identity', text: 'AI' }] }
  const unrestricted = rewritePromptAssembly(assembled, { session: { agentPreset: 'unrestricted' } }, 'Prompt')
  const standard = rewritePromptAssembly(assembled, { session: { agentPreset: 'standard' } }, 'Prompt')
  assert.equal(standard, assembled)
})

test('registered definition and agent.cordis.yml describe the same tool set', async () => {
  const yaml = await readFile(new URL('../host/purge/presets/unrestricted/agent.cordis.yml', import.meta.url), 'utf8')
  const yamlNames = new Set([...yaml.matchAll(/name:\s*'?(@deepseek-ai\/[\w/-]+)'?/g)].map((match) => match[1]))
  const json = JSON.parse(await readFile(new URL('../host/purge/presets/unrestricted/preset.json', import.meta.url), 'utf8'))
  const walk = (rows) => rows.flatMap((row) => (Array.isArray(row.config) ? [row.name, ...walk(row.config)] : [row.name]))
  const jsonNames = new Set(walk(json.plugins).filter((name) => name.startsWith('@deepseek-ai/')))
  assert.deepEqual([...jsonNames].sort(), [...yamlNames].sort())
})
