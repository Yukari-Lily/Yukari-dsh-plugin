/**
 * 回撤标记事件。
 *
 * 回撤不改日志、不删事件：追加一条 `user/message`，用 `surfaceOp.replace` 把
 * "目标消息到末尾"整段替换掉。它是唯一能携带 `sourceEventSeqs` 且能替换多节点的
 * 消息类型（`assistant/message` 不能带来源引用）。
 *
 * 标记带自己的 `source.kind`：宿主里真实用户消息（含 `user-rpc`）都是
 * `kind: 'user'`，标记若也用这个值，回撤就能把标记本身当成目标，无限追加空标记。
 *
 * 正文不能为空：会话日志是不可变的，而将来服务这枚会话的模型可能换成一个严格的
 * OpenAI 兼容网关，空用户消息会被拒成 400。
 * @module yukari-dsh-plugin/rewind/marker
 */

import { randomUUID } from 'node:crypto'

/** 标记事件固定的正文。 */
export const MARKER_TEXT = '(empty message)'

/** 标记事件自己的来源类型：既不是用户消息，也不与宿主任何注入类型重名。 */
export const MARKER_SOURCE_KIND = 'rewind-marker'

/**
 * 构造一条标记事件的数据部分。
 *
 * `source.start` 是这次回撤的起点序号：宿主的 Chat 投影会把 `source` 原样带到
 * 渲染节点上（`contextMessage` 里 `source: message.source`），客户端的可见性包装
 * 器因此能从节点流里还原"隐藏哪一段"，不必知道会话号，也不必依赖服务端 cuts。
 * @param cut - `planCut` 的结果；缺省时只写来源类型（旧调用与测试用）。
 * @returns `user/message` 的 data。
 */
export function markerData(cut) {
  const start = Number.isSafeInteger(cut?.startSeq) ? cut.startSeq : undefined
  return {
    content: [{ type: 'text', text: MARKER_TEXT }],
    source: start === undefined ? { kind: MARKER_SOURCE_KIND } : { kind: MARKER_SOURCE_KIND, start },
    role: 'user',
    id: randomUUID(),
  }
}

/**
 * 构造追加参数：替换区间，以及被遮蔽节点的完整引用。
 * @param cut - `planCut` 的结果。
 * @returns `session.append` 的第三个参数。
 */
export function markerOptions(cut) {
  return {
    surfaceOp: { op: 'replace', startSeq: cut.startSeq, endSeq: cut.endSeq },
    sourceEventSeqs: cut.shadowed,
  }
}
