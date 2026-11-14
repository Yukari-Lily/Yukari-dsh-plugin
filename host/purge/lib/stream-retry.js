/**
 * Refusal detection and one-shot retry for Unrestricted Mode.
 *
 * Mounted on the `llm/stream` waterfall: a model call is buffered for its first
 * few hundred characters, classified, and — when it opens with a refusal — the
 * original stream is discarded and the same request is reissued once with a
 * closing instruction appended to its system message.
 *
 * Nothing here runs outside a session the rewriter has already marked as
 * unrestricted, so standard sessions never pay for it.
 */
import { RETRY_MARKER, RETRY_NUDGE } from './prompts.js'

/** Openers that are a refusal on their own, whatever follows. */
const STRONG = [
  /^[\s]*很?抱歉[，,。:：;；\s]/,
  /^[\s]*对不起[，,。:：;；\s]/,
  /^[\s]*不好意思[，,。:：;；\s]/,
  /^[\s]*(?:I'm|I am) sorry\b/i,
  /^[\s]*Sorry\b[,.]/i,
  /^[\s]*I (?:can(?:'|’)?t|cannot|won(?:'|’)?t|am unable to)\b/i,
  /^[\s]*As an AI\b/i,
  /^[\s]*作为\s*(?:一个)?\s*(?:AI|人工智能|语言模型|助手)/,
  /^[\s]*我(?:不能|无法)(?:协助|帮助|提供|满足|参与|完成|做到)/,
]

/** Phrases that only count as a refusal when they are not quoting or analysing one. */
const WEAK = [
  /我(?:不能|无法)(?:协助|帮助|提供|满足|参与|完成)/,
  /(?:请求|要求)[^。]{0,6}(?:超出|越出)了?我(?:的)?(?:能力|职责|范围)/,
  /\bAs an AI(?: language model)?\b/i,
  /\bI (?:can(?:'|’)?t|cannot|am unable to) (?:help|assist|provide|comply)\b/i,
  /\bI must decline\b/i,
  /(?:建议|请)(?:你|您)(?:寻求|咨询)(?:专业|法律|律师)/,
]

/** Words that mark a passage as *about* refusals rather than a refusal. */
const META = /提示词注入|越狱|指令注入|拒绝话术|prompt[ _-]?injection|jailbreak|refusal/i

/** Chunks that end the classification window no matter what was read so far. */
const DECIDES = new Set(['tool-call', 'tool-call-delta', 'reasoning-delta', 'finish', 'error', 'aborted'])

/** A refusal is only classified from the opening of a message. */
export const HEAD_LIMIT = 400

/** Longer passages that merely discuss refusals are left alone. */
const META_BODY_LIMIT = 280

/** Join the text blocks of a message or content array. */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * Classify the opening of a model reply.
 *
 * @param text - the buffered leading text of one assistant message.
 * @returns whether it reads as a refusal rather than an answer.
 */
export function looksLikeRefusal(text) {
  const raw = String(text ?? '')
  if (raw.trim() === '') return false
  const head = raw.slice(0, HEAD_LIMIT)
  if (STRONG.some((pattern) => pattern.test(head))) return true
  if (!WEAK.some((pattern) => pattern.test(head))) return false
  // A long passage that names the topic is discussing it, not doing it.
  if (head.length > META_BODY_LIMIT && META.test(head)) return false
  return true
}

/**
 * Whether this request is a loop-built conversation request.
 *
 * The host stamps auxiliary calls with `purpose` — `compaction`
 * (`dsh-compaction-basic`), `session-title` (`dsh-session-title-llm`) and
 * `auto-review` (`dsh-experimental-auto-review`) declare one; an ordinary
 * conversation request leaves the field unset (`GenerateOptions.purpose` in
 * `@deepseek-ai/dsh-llm`). Retrying an auxiliary call would feed a re-asked
 * prompt into a summary or a title, so a request whose shape cannot be judged
 * counts as auxiliary: not retrying is the safe side.
 */
export function isConversationRequest(request) {
  if (!request || typeof request !== 'object') return false
  if (request.purpose !== undefined) return false
  const messages = Array.isArray(request.messages) ? request.messages : null
  if (messages === null || messages.length === 0) return false
  return messages.some((message) => message?.role === 'user')
}

/** Whether this request already carries the retry marker. */
export function isRetried(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  return messages.some((message) => message?.role === 'system' && textOf(message).includes(RETRY_MARKER))
}

/**
 * Rebuild a request with the nudge appended to its system message.
 *
 * The host deep-freezes requests and messages, so this never mutates: it returns
 * a new request, or `null` when there is no system message to extend.
 *
 * @param options - the frozen request the agent loop built.
 * @param nudge - the text to append.
 * @returns a new request, or `null` when the request cannot be nudged safely.
 */
export function withNudge(options, nudge = RETRY_NUDGE) {
  const messages = Array.isArray(options?.messages) ? options.messages : null
  if (messages === null || messages.length === 0) return null
  const index = messages.findIndex((message) => message?.role === 'system')
  if (index < 0) return null
  const target = messages[index]
  if (textOf(target).includes(RETRY_MARKER)) return null

  let content
  if (typeof target.content === 'string') {
    content = target.content + nudge
  } else if (Array.isArray(target.content)) {
    const blocks = target.content.map((block) => (block && typeof block === 'object' ? { ...block } : block))
    let last = -1
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i]?.type === 'text' && typeof blocks[i].text === 'string') last = i
    }
    if (last >= 0) blocks[last] = { ...blocks[last], text: blocks[last].text + nudge }
    else blocks.push({ type: 'text', text: nudge })
    content = blocks
  } else {
    return null
  }

  const patched = messages.slice()
  patched[index] = { ...target, content }
  return { ...options, messages: patched }
}

/**
 * Wrap one stream so a refusal can be replaced by a single retry.
 *
 * The classification window is filled before the first chunk is yielded, so a
 * retry can only replace a stream the caller has not started reading yet. The
 * reissued stream is yielded verbatim: it is never classified again, and the
 * request carrying the retry marker is refused by `isRetried` anyway.
 *
 * @param source - the stream (or a promise of one) produced downstream.
 * @param options - the request that produced it.
 * @param io - `{ reissue, nudge, bufferChars, report }`.
 * @returns an async iterable that yields exactly what the caller would have seen,
 *          or the reissued stream when a refusal was discarded.
 */
export async function* retryableStream(source, options, io) {
  const { reissue, nudge = RETRY_NUDGE, bufferChars = HEAD_LIMIT, report } = io
  const stream = await source
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    if (stream !== undefined && stream !== null) yield stream
    return
  }

  const iterator = stream[Symbol.asyncIterator]()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await iterator.return?.()
    } catch {
      /* the original stream is being abandoned; its teardown failure is not ours */
    }
  }

  const buffered = []
  let head = ''
  // 一旦有 chunk 交给调用方，就不能再丢弃重来；这条判定把重试限制在“尚未吐字节”之前。
  let started = false
  try {
    while (true) {
      const step = await iterator.next()
      if (step.done) break
      buffered.push(step.value)
      if (step.value?.type === 'text-delta') head += String(step.value.text ?? '')
      if (head.length >= bufferChars || DECIDES.has(step.value?.type)) break
    }

    if (!started && looksLikeRefusal(head) && typeof reissue === 'function' && !isRetried(options)) {
      const patched = withNudge(options, nudge)
      if (patched !== null) {
        let retry = null
        try {
          retry = await reissue(patched)
        } catch {
          retry = null
        }
        if (retry && typeof retry[Symbol.asyncIterator] === 'function') {
          await close()
          report?.({ event: 'retried', chars: head.length })
          for await (const chunk of retry) {
            started = true
            yield chunk
          }
          return
        }
      }
      report?.({ event: 'skipped', chars: head.length })
    }

    for (const chunk of buffered) {
      started = true
      yield chunk
    }
    while (true) {
      const step = await iterator.next()
      if (step.done) return
      started = true
      yield step.value
    }
  } finally {
    await close()
  }
}

/**
 * Install the `llm/stream` listener.
 *
 * @param ctx - the plugin context.
 * @param options - `allowed(request)`, `reissue(request)`, `report(entry)`.
 * @returns the disposer.
 */
export function installStreamRetry(ctx, options = {}) {
  const { allowed, reissue, report } = options
  if (typeof ctx?.on !== 'function') return () => {}
  try {
    return ctx.on(
      'llm/stream',
      (request, next) => {
        const stream = typeof next === 'function' ? next() : undefined
        try {
          if (!request || typeof request !== 'object') return stream
          if (!isConversationRequest(request)) return stream
          if (isRetried(request)) return stream
          if (typeof allowed !== 'function' || !allowed(request)) return stream
          return retryableStream(stream, request, { reissue, report, nudge: RETRY_NUDGE })
        } catch {
          return stream
        }
      },
      { global: true, prepend: true },
    )
  } catch {
    return () => {}
  }
}
