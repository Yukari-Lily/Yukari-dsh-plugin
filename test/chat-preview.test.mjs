import test from 'node:test'
import assert from 'node:assert/strict'
import { previewOf } from '../host/chats/lib/preview.js'
import { createAdmin } from '../host/chats/lib/admin.js'

const user = (seq, text, source = { kind: 'user' }) => ({
  seq,
  type: 'user/message',
  data: { role: 'user', source, content: [{ type: 'text', text }] },
  surfaceOp: 'append',
})

const assistant = (seq, text) => ({
  seq,
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  surfaceOp: 'append',
})

test('preview returns the latest visible turns, not injected context or tool rows', () => {
  const events = [
    user(0, '第一条'),
    assistant(1, '第一答'),
    user(2, '运行时上下文', { kind: 'runtime-context' }),
    { seq: 3, type: 'tool/result', data: {}, surfaceOp: 'append' },
    user(4, '第二条'),
    assistant(5, '第二答'),
  ]
  assert.deepEqual(previewOf(events, 2), {
    turns: 2,
    messages: [{ role: 'user', text: '第二条' }, { role: 'assistant', text: '第二答' }],
  })
})

test('preview follows surface replacements, so rewound messages stay hidden', () => {
  const marker = user(4, '回撤标记', { kind: 'rewind-marker' })
  marker.surfaceOp = { op: 'replace', startSeq: 2, endSeq: 3 }
  const events = [user(0, '保留问题'), assistant(1, '保留回答'), user(2, '已回撤'), assistant(3, '已回撤回答'), marker, assistant(5, '新回答')]
  assert.deepEqual(previewOf(events), {
    turns: 1,
    messages: [{ role: 'user', text: '保留问题' }, { role: 'assistant', text: '保留回答' }, { role: 'assistant', text: '新回答' }],
  })
})

test('preview bounds the number and size of returned messages', () => {
  const events = [user(0, 'x'.repeat(2001)), assistant(1, ''), user(2, '末尾')]
  const result = previewOf(events, 20)
  assert.equal(result.messages.length, 2)
  assert.equal(result.messages[0].text.length, 2001)
  assert.ok(result.messages[0].text.endsWith('…'))
})

test('admin preview prefers the live log and closes a persisted read handle', async () => {
  let closed = 0
  const ctx = {
    sessionQuery: { listSessions: async () => [] },
    sessionPersistence: {
      open: async (id) => ({
        read: async () => ({ events: [user(0, `磁盘 ${id}`)] }),
        close: async () => { closed += 1 },
      }),
    },
    sessions: {
      get: (id) => id === 'live' ? { snapshotEvents: () => [user(0, '内存')] } : undefined,
    },
  }
  const admin = createAdmin({ ctx })
  assert.deepEqual(await admin.preview({ sessionId: 'live' }), {
    id: 'live', live: true, turns: 1, messages: [{ role: 'user', text: '内存' }],
  })
  assert.deepEqual(await admin.preview({ sessionId: 'disk', limit: 1 }), {
    id: 'disk', live: false, turns: 1, messages: [{ role: 'user', text: '磁盘 disk' }],
  })
  assert.equal(closed, 1)
  await assert.rejects(admin.preview({ sessionId: '' }), /未指定要预览的会话/u)
  await assert.rejects(admin.preview({ sessionId: '../bad' }), /会话 id 不合法/u)
})
