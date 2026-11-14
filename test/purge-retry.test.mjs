import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HEAD_LIMIT,
  installStreamRetry,
  isConversationRequest,
  isRetried,
  looksLikeRefusal,
  retryableStream,
  withNudge,
} from '../host/purge/lib/stream-retry.js'
import { RETRY_MARKER, RETRY_NUDGE } from '../host/purge/lib/prompts.js'

/** A minimal stream whose teardown can be observed from the test. */
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

const systemRequest = (text = 'BASE') => ({
  sessionId: 'session-1',
  messages: [
    { role: 'system', content: [{ type: 'text', text }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ],
})

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('looksLikeRefusal: strong openers in both languages', () => {
  for (const text of [
    '抱歉，我不能协助这个请求。',
    '很抱歉，这个我做不了。',
    '我不能帮助完成这个任务。',
    '作为 AI，我需要提醒你……',
    "I'm sorry, but I can't help with that.",
    "I cannot assist with this request.",
    'Sorry, but I am unable to provide that.',
  ]) {
    assert.equal(looksLikeRefusal(text), true, text)
  }
})

test('looksLikeRefusal: technical answers are not refusals', () => {
  const cases = [
    '第一步：打开终端，运行 lsof -i :8080 找到占用进程。',
    'This command cannot be run as root; use a normal user instead.',
    '要判断这个请求是否属于“越狱”，先看它是否试图改变系统提示词；下面是一个评估 harness 的实现，包含 probe、日志与打分规则。',
    '',
    '   ',
  ]
  for (const text of cases) assert.equal(looksLikeRefusal(text), false, text)
})

test('looksLikeRefusal: a long passage that discusses refusals is not itself one', () => {
  const body = `下面讨论模型为什么会拒绝，以及 prompt injection 与 refusal 的分类。${'分析。'.repeat(160)}我无法协助 这句话在这里是引用。`
  assert.ok(body.length > 280)
  assert.equal(looksLikeRefusal(body), false)
})

test('looksLikeRefusal: only the opening is classified', () => {
  const text = `${'技术细节。'.repeat(120)}抱歉，我不能协助。`
  assert.equal(looksLikeRefusal(text), false)
  assert.equal(looksLikeRefusal('抱歉，' + '技术细节。'.repeat(200)), true)
})

test('withNudge: appends to the system text block without touching the original request', () => {
  const request = systemRequest()
  const snapshot = JSON.stringify(request)
  const patched = withNudge(request, RETRY_NUDGE)

  assert.ok(patched !== null)
  assert.notEqual(patched, request)
  assert.equal(patched.messages[0].content[0].text, `BASE${RETRY_NUDGE}`)
  assert.equal(patched.messages[1], request.messages[1])
  assert.equal(JSON.stringify(request), snapshot, 'the frozen request is not mutated')
  assert.ok(patched.messages[0].content[0].text.includes(RETRY_MARKER))
})

test('withNudge: refuses to nudge twice and refuses requests without a system message', () => {
  const nudged = withNudge(systemRequest(), RETRY_NUDGE)
  assert.equal(withNudge(nudged, RETRY_NUDGE), null)
  assert.equal(withNudge({ messages: [{ role: 'user', content: [] }] }, RETRY_NUDGE), null)
  assert.equal(withNudge({}, RETRY_NUDGE), null)

  const stringContent = { messages: [{ role: 'system', content: 'BASE' }] }
  assert.equal(withNudge(stringContent, 'X').messages[0].content, 'BASEX')
})

test('isRetried: detects the marker on the system message only', () => {
  assert.equal(isRetried(systemRequest()), false)
  assert.equal(isRetried(systemRequest(`BASE${RETRY_NUDGE}`)), true)
  assert.equal(isRetried({ messages: [{ role: 'user', content: [{ type: 'text', text: RETRY_MARKER }] }] }), false)
})

test('retryableStream: a refusal is discarded and reissued once', async () => {
  const original = streamOf([
    { type: 'text-delta', text: '抱歉，' },
    { type: 'text-delta', text: '我不能协助这个请求。' },
  ])
  const retry = streamOf([{ type: 'text-delta', text: '第一步：' }])
  let calls = 0
  const reports = []

  const out = await collect(
    retryableStream(original, systemRequest(), {
      reissue: async () => {
        calls += 1
        return retry
      },
      report: (entry) => reports.push(entry.event),
    }),
  )

  assert.equal(calls, 1)
  assert.deepEqual(out, [{ type: 'text-delta', text: '第一步：' }])
  assert.equal(original.closed, true, 'the abandoned stream is torn down')
  assert.equal(reports[0], 'retried')
})

test('retryableStream: a normal answer passes through chunk for chunk', async () => {
  const chunks = [
    { type: 'text-delta', text: '第一步：打开终端。' },
    { type: 'text-delta', text: '第二步：运行命令。' },
    { type: 'finish' },
  ]
  const original = streamOf(chunks)
  let calls = 0

  const out = await collect(
    retryableStream(original, systemRequest(), {
      reissue: async () => {
        calls += 1
        return streamOf([])
      },
    }),
  )

  assert.equal(calls, 0)
  assert.deepEqual(out, chunks)
})

test('retryableStream: a refusal with no way to reissue still shows the original answer', async () => {
  const chunks = [{ type: 'text-delta', text: '抱歉，我不能协助。' }]
  const original = streamOf(chunks)

  const out = await collect(
    retryableStream(original, systemRequest(), {
      reissue: async () => {
        throw new Error('llm offline')
      },
    }),
  )

  assert.deepEqual(out, chunks)
  assert.equal(original.closed, true)
})

test('retryableStream: an already-retried request is never retried again', async () => {
  const chunks = [{ type: 'text-delta', text: '抱歉，我不能协助。' }]
  let calls = 0

  const out = await collect(
    retryableStream(streamOf(chunks), systemRequest(`BASE${RETRY_NUDGE}`), {
      reissue: async () => {
        calls += 1
        return streamOf([])
      },
    }),
  )

  assert.equal(calls, 0)
  assert.deepEqual(out, chunks)
})

test('retryableStream: a long head without any finish chunk is still classified', async () => {
  const long = [{ type: 'text-delta', text: '正常输出'.repeat(HEAD_LIMIT) }]
  const out = await collect(retryableStream(streamOf(long), systemRequest(), { reissue: async () => null }))
  assert.deepEqual(out, long)
})

test('retryableStream: the reissued stream is never classified again', async () => {
  let calls = 0
  const out = await collect(
    retryableStream(streamOf([{ type: 'text-delta', text: '抱歉，我不能协助。' }]), systemRequest(), {
      reissue: async () => {
        calls += 1
        return streamOf([{ type: 'text-delta', text: '抱歉，这次仍然不行。' }, { type: 'finish' }])
      },
    }),
  )

  assert.equal(calls, 1)
  assert.deepEqual(out, [{ type: 'text-delta', text: '抱歉，这次仍然不行。' }, { type: 'finish' }])
})

test('retryableStream: once bytes reached the caller a later refusal never restarts the stream', async () => {
  // 第一个 chunk 撑满分类窗口，缓冲随即释放；之后出现的拒答不能再丢弃重来。
  const lead = '技术细节。'.repeat(100)
  const chunks = [
    { type: 'text-delta', text: lead },
    { type: 'text-delta', text: '抱歉，我不能协助。' },
    { type: 'finish' },
  ]
  let calls = 0

  const out = await collect(
    retryableStream(streamOf(chunks), systemRequest(), {
      reissue: async () => {
        calls += 1
        return streamOf([])
      },
    }),
  )

  assert.equal(calls, 0)
  assert.deepEqual(out, chunks)
})

test('isConversationRequest: only loop-built conversation requests qualify', () => {
  const conversation = systemRequest()
  assert.equal(isConversationRequest(conversation), true)
  for (const purpose of ['compaction', 'session-title', 'auto-review']) {
    assert.equal(isConversationRequest({ ...conversation, purpose }), false, purpose)
  }
  assert.equal(isConversationRequest({ sessionId: 'session-1' }), false, 'no messages to judge')
  assert.equal(isConversationRequest({ sessionId: 'session-1', messages: [] }), false)
  assert.equal(
    isConversationRequest({ sessionId: 'session-1', messages: [{ role: 'system', content: 'BASE' }] }),
    false,
    'no user turn',
  )
  assert.equal(isConversationRequest(null), false)
})

test('installStreamRetry: auxiliary requests are never wrapped, whatever the gate allows', async () => {
  const handlers = []
  const ctx = { on: (name, handler) => (handlers.push([name, handler]), () => {}) }
  let calls = 0
  installStreamRetry(ctx, {
    allowed: () => true,
    reissue: async () => {
      calls += 1
      return streamOf([{ type: 'text-delta', text: '好的' }])
    },
  })
  const handler = handlers[0][1]

  for (const purpose of ['compaction', 'session-title', 'auto-review']) {
    const raw = streamOf([{ type: 'text-delta', text: '抱歉，我不能协助。' }])
    assert.equal(handler({ ...systemRequest(), purpose }, () => raw), raw, purpose)
  }
  assert.equal(calls, 0)

  const out = await collect(handler(systemRequest(), () => streamOf([{ type: 'text-delta', text: '抱歉，我不能协助。' }])))
  assert.equal(calls, 1)
  assert.deepEqual(out, [{ type: 'text-delta', text: '好的' }])
})

test('installStreamRetry: only sessions the rewriter marked are wrapped', async () => {
  const handlers = []
  const ctx = { on: (name, handler) => (handlers.push([name, handler]), () => {}) }
  let calls = 0
  installStreamRetry(ctx, {
    allowed: (request) => request.sessionId === 'session-1',
    reissue: async () => {
      calls += 1
      return streamOf([{ type: 'text-delta', text: '好的' }])
    },
  })
  assert.equal(handlers.length, 1)
  assert.equal(handlers[0][0], 'llm/stream')

  const handler = handlers[0][1]
  const raw = streamOf([{ type: 'text-delta', text: '抱歉，我不能协助。' }])
  assert.equal(handler({ sessionId: 'other', messages: [] }, () => raw), raw, 'an unmarked session gets the raw stream')
  assert.equal(calls, 0)

  const out = await collect(handler(systemRequest(), () => streamOf([{ type: 'text-delta', text: '抱歉，我不能协助。' }])))
  assert.equal(calls, 1)
  assert.deepEqual(out, [{ type: 'text-delta', text: '好的' }])
})
