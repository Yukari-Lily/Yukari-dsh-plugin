/**
 * 会话 surface 的折叠，以及"从这里回撤"的区间计算。
 *
 * 宿主日志是 append-only 的：模型真正看到的是 surface —— 日志里带 surfaceOp
 * 标记的消息事件按替换规则叠出来的序列。回撤要做的是把"这条用户消息到 surface
 * 末尾"整段替换成一条标记消息，所以先把当前 surface 算出来。
 *
 * 这里只实现折叠本身，不依赖宿主包：事件数组进，序号数组出。
 * @module yukari-dsh-plugin/rewind/surface
 */

import { MARKER_TEXT } from './marker.js'

/** 能进入 surface 的消息事件类型。 */
export const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** 事件是否按追加方式进入 surface。 */
const appended = (event) => event.surfaceOp === 'append'

/** 事件是否带着一段替换区间。 */
const replaced = (event) => event.surfaceOp !== undefined && event.surfaceOp !== 'append'

/**
 * 算出一条日志当前的 surface 序号序列。
 * @param events - 按 seq 连续排列的事件。
 * @returns surface 上每个节点的事件序号，按对话顺序。
 */
export function surfaceNodes(events) {
  const nodes = []
  for (const event of events) {
    if (!SURFACE_TYPES.has(event.type)) continue
    if (appended(event)) {
      nodes.push(event.seq)
      continue
    }
    if (!replaced(event)) continue
    const { startSeq, endSeq } = event.surfaceOp
    const start = nodes.indexOf(startSeq)
    const end = nodes.indexOf(endSeq)
    // 折叠只处理当前日志：区间两端必须都还在 surface 上。
    if (start === -1 || end === -1 || start > end) continue
    nodes.splice(start, end - start + 1, event.seq)
  }
  return nodes
}

/**
 * 计算回撤到某条消息时要替换掉的 surface 区间。
 * @param events - 按 seq 连续排列的事件。
 * @param targetSeq - 目标用户消息的序号。
 * @returns `{ startSeq, endSeq, shadowed }`，目标不在 surface 上时返回 null。
 */
export function planCut(events, targetSeq) {
  const nodes = surfaceNodes(events)
  const index = nodes.indexOf(targetSeq)
  if (index === -1) return null
  const shadowed = nodes.slice(index)
  return { startSeq: targetSeq, endSeq: shadowed[shadowed.length - 1], shadowed }
}

/** 一条标记事件的正文。 */
function markerText(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return null
  const text = content.find((block) => block?.type === 'text')
  return typeof text?.text === 'string' ? text.text : null
}

/**
 * 从日志里已有的标记事件推导出每一次回撤的区间。
 * @param events - 按 seq 连续排列的事件。
 * @returns `[{ target, marker }]`，target 是目标消息序号，marker 是标记事件序号。
 */
export function cutsOf(events) {
  const cuts = []
  for (const event of events) {
    if (event.type !== 'user/message' || !replaced(event)) continue
    if (markerText(event) !== MARKER_TEXT) continue
    const { startSeq } = event.surfaceOp
    if (Number.isSafeInteger(startSeq)) cuts.push({ target: startSeq, marker: event.seq })
  }
  return cuts
}
