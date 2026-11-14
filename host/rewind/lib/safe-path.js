/**
 * 会话 id 与工作区路径的边界检查。
 *
 * `sessionId` 来自 HTTP 请求体，拼接进 `$DSH_HOME/rewind` 之前必须先确认它只能是
 * 一个路径段：否则 `../..` 能把快照目录指到根目录之外。快照的捕获与还原都只处理
 * 工作区里的普通文件，所以这里同时提供"路径是否在根目录内"的判断。
 * @module yukari-dsh-plugin/rewind/safe-path
 */

import path from 'node:path'

/** 允许出现在快照目录名里的会话 id。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * 断言会话 id 是一个安全的路径段。
 * @param sessionId - 请求里带来的会话 id。
 * @returns 同一个 id，方便链式使用。
 * @throws 不是字符串、为空、是 `.`/`..` 或含其它字符时抛 400。
 */
export function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') throw badRequest('未指定会话。')
  if (sessionId === '.' || sessionId === '..' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw badRequest('会话标识不合法。')
  }
  return sessionId
}

/**
 * 判断 `candidate` 是否就是 `root` 或位于其下（纯字面量比较，调用方负责先规范化）。
 * @param root - 规范化的根目录。
 * @param candidate - 规范化的候选路径。
 * @returns 是否在根目录内。
 */
export function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/** 带状态码的请求错误。 */
function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}
