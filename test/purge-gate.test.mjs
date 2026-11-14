import test from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_CAP, createRetryGate } from '../host/purge/lib/retry-gate.js'

/** 一个只承担预设查询的智能体上下文：`composedPreset` 决定它是否仍在无限制模式。 */
function contextOf(id, presetOf) {
  const presets = { composedPreset: () => presetOf() }
  return {
    agent: { session: { id }, ctx: { get: (name) => (name === 'agentPresets' ? presets : undefined) } },
  }
}

const fixedClock = (start = 0) => {
  let value = start
  const now = () => value
  now.advance = (ms) => {
    value += ms
  }
  return now
}

test('retry gate: a noted session is eligible while it stays on the unrestricted preset', () => {
  const gate = createRetryGate()
  let preset = 'unrestricted'
  assert.equal(gate.note(contextOf('session-1', () => preset)), true)
  assert.equal(gate.isEligible('session-1'), true)

  preset = 'standard'
  assert.equal(gate.isEligible('session-1'), false, 'a session that left the preset must not be retried')
  assert.equal(gate.size, 0, 'the stale entry is dropped, not just ignored')
})

test('retry gate: entries expire so an abandoned session cannot be retried later', () => {
  const now = fixedClock()
  const gate = createRetryGate({ now, ttlMs: 1000 })
  gate.note(contextOf('session-1', () => 'unrestricted'))

  now.advance(1000)
  assert.equal(gate.isEligible('session-1'), true, 'still inside the window')

  now.advance(1)
  assert.equal(gate.isEligible('session-1'), false)
  assert.equal(gate.size, 0)
})

test('retry gate: the cap evicts the oldest session instead of growing forever', () => {
  const gate = createRetryGate({ cap: 2 })
  gate.note(contextOf('a', () => 'unrestricted'))
  gate.note(contextOf('b', () => 'unrestricted'))
  gate.note(contextOf('c', () => 'unrestricted'))

  assert.equal(gate.size, 2)
  assert.equal(gate.isEligible('a'), false)
  assert.equal(gate.isEligible('b'), true)
  assert.equal(gate.isEligible('c'), true)
})

test('retry gate: a forget call removes the session immediately', () => {
  const gate = createRetryGate()
  gate.note(contextOf('session-1', () => 'unrestricted'))
  gate.forget('session-1')
  assert.equal(gate.isEligible('session-1'), false)
})

test('retry gate: sessions without an id are not recorded', () => {
  const gate = createRetryGate()
  assert.equal(gate.note({}), false)
  assert.equal(gate.note({ agent: { session: {} } }), false)
  assert.equal(gate.size, 0)
})

test('retry gate: the default cap matches the documented limit', () => {
  assert.equal(SESSION_CAP, 500)
})
