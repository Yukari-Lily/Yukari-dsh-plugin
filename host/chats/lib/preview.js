/**
 * 会话悬停预览的日志投影。
 *
 * 只取当前对话面上的真人消息与助手正文：注入上下文、工具调用、已被回撤的
 * 区间都不进入卡片。消息正文限量返回，预览不是完整日志导出。
 * @module @local/chat-manager/preview
 */

/** 一张卡片最多携带的对话条数。 */
const DEFAULT_MESSAGES = 6

/** 单条正文上限；界面另有行数截断。 */
const MAX_TEXT_CHARS = 2000

/** 参与 surface 替换计算的事件。 */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** 当前对话面上的事件序号。 */
function activeSeqs(events) {
  const nodes = []
  for (const event of events) {
    if (!SURFACE_TYPES.has(event?.type)) continue
    if (event.surfaceOp === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (event.surfaceOp === undefined) continue
    const start = nodes.indexOf(event.surfaceOp.startSeq)
    const end = nodes.indexOf(event.surfaceOp.endSeq)
    if (start === -1 || end === -1 || start > end) continue
    nodes.splice(start, end - start + 1, event.seq)
  }
  return new Set(nodes)
}

/** 一条用户或助手消息的纯文本。 */
function messageOf(event) {
  if (event?.type === 'user/message') {
    if (event.data?.source?.kind !== 'user' || event.data?.role !== 'user') return null
    return { role: 'user', content: event.data.content }
  }
  if (event?.type === 'assistant/message') return { role: 'assistant', content: event.data?.message?.content }
  return null
}

/** 拼接文本块，忽略图片与思考块。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  const text = content.map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n').trim()
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS)}…`
}

/**
 * 提取当前对话的轮数与末尾几条消息。
 * @param events - 按 seq 连续排列的日志事件。
 * @param limit - 返回消息条数，最多 20。
 * @returns `{ turns, messages }`。
 */
export function previewOf(events, limit = DEFAULT_MESSAGES) {
  const list = Array.isArray(events) ? events : []
  const count = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 20) : DEFAULT_MESSAGES
  const active = activeSeqs(list)
  const visible = []
  let turns = 0
  for (const event of list) {
    if (!active.has(event?.seq)) continue
    const message = messageOf(event)
    if (message === null) continue
    if (message.role === 'user') turns += 1
    const text = textOf(message.content)
    if (text !== '') visible.push({ role: message.role, text })
  }
  return { turns, messages: visible.slice(-count) }
}
