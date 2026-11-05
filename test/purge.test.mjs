import test from 'node:test'
import assert from 'node:assert/strict'
import { rewritePromptAssembly, isUnrestrictedSession, escapeDshInterpolation } from '../host/purge/lib/rewriter.js'
import { DEFAULT_PURGE_PROMPT } from '../host/purge/lib/default-prompt.js'
import { getPresetDefinition, UNRESTRICTED_PRESET_ID } from '../host/purge/lib/preset.js'

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
})
