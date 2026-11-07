/**
 * 回撤标记事件。
 *
 * 回撤不改日志、不删事件：追加一条 `user/message`，用 `surfaceOp.replace` 把
 * "目标消息到末尾"整段替换掉。它是唯一能携带 `sourceEventSeqs` 且能替换多节点的
 * 消息类型（`assistant/message` 不能带来源引用）。
 *
 * 正文不能为空：会话日志是不可变的，而将来服务这枚会话的模型可能换成一个严格的
 * OpenAI 兼容网关，空用户消息会被拒成 400。
 * @module yukari-dsh-plugin/rewind/marker
 */

import { randomUUID } from 'node:crypto'

/** 标记事件固定的正文。 */
export const MARKER_TEXT = '(empty message)'

/**
 * 构造一条标记事件的数据部分。
 * @returns `user/message` 的 data。
 */
export function markerData() {
  return {
    content: [{ type: 'text', text: MARKER_TEXT }],
    source: { kind: 'user' },
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
