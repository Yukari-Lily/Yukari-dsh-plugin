/**
 * 回撤的编排：查事件、等空闲、追加标记、还原文件。
 *
 * 会话本身不拷贝、不新开：追加一条标记消息，用 surface 替换把"目标消息到末尾"
 * 整段从模型可见历史里切掉；文件由写前快照写回。日志永远只增不改。
 * @module yukari-dsh-plugin/rewind/controller
 */

import { messageOf } from '../../shared/http.js'
import { MARKER_TEXT, markerData, markerOptions } from './marker.js'
import { cutsOf, planCut } from './surface.js'

/** 等一次运行中的回合停下来最多多久。 */
const IDLE_TIMEOUT_MS = 15000

/** 轮询间隔。 */
const IDLE_POLL_MS = 200

/** 带状态码的错误。 */
function failure(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** 读一个可选服务。 */
function optionalService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  } catch {
    return undefined
  }
}

/**
 * 建回撤编排。
 * @param args - 插件上下文与快照仓库。
 * @returns plan / apply / cuts / capture。
 */
export function createRewind({ ctx, store }) {
  const sessions = optionalService(ctx, 'sessions')
  const persistence = optionalService(ctx, 'sessionPersistence')
  const agents = optionalService(ctx, 'agents')

  /** 当前加载着的会话。 */
  const liveSession = (sessionId) => (sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined)

  /** 一个会话的事件；没加载就读磁盘。 */
  async function eventsOf(sessionId) {
    const live = liveSession(sessionId)
    if (live !== undefined) return live.snapshotEvents()
    if (persistence === undefined || typeof persistence.open !== 'function') throw failure(404, '找不到会话。')
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
      const read = await handle.read()
      return read.events
    } catch (error) {
      throw failure(404, `找不到会话：${messageOf(error)}`)
    } finally {
      try {
        await handle?.close()
      } catch {
        /* 读句柄关不掉不影响结果 */
      }
    }
  }

  /** 回合在跑就先停它，再等它真的停下来。 */
  async function settle(sessionId) {
    const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined) return
    if (agent.status === 'running') {
      try {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
      } catch (error) {
        throw failure(409, `无法停止正在运行的回合：${messageOf(error)}`)
      }
    }
    const deadline = Date.now() + IDLE_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (agent.status !== 'running') return
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS))
    }
    throw failure(409, '会话仍在运行，无法回撤。')
  }

  /** 目标必须是 surface 上的一条用户消息。 */
  function targetOf(events, seq) {
    const event = events[seq]
    if (event === undefined || event.type !== 'user/message') throw failure(409, '只能回撤到用户消息。')
    const cut = planCut(events, seq)
    if (cut === null) throw failure(409, '这条消息已经不在当前对话里。')
    if (cut.shadowed.length === 0) throw failure(409, '这条消息之后没有内容。')
    return { event, cut }
  }

  /**
   * 预览：回撤会切掉多少、动哪些文件。
   * @param request - `{ sessionId, seq }`。
   */
  async function plan({ sessionId, seq }) {
    if (typeof sessionId !== 'string' || sessionId === '') throw failure(400, '未指定会话。')
    if (!Number.isSafeInteger(seq) || seq < 0) throw failure(400, '未指定回撤到的消息。')
    const events = await eventsOf(sessionId)
    const { cut } = targetOf(events, seq)
    const files = await store.planRestore(sessionId, seq)
    return {
      startSeq: cut.startSeq,
      endSeq: cut.endSeq,
      // 界面显示的是"撤下几条对话"，也就是区间里用户自己发的消息条数；
      // surface 节点数与屏幕上行数都不直观（一次对话可能带很多工具调用行）。
      human: humanMessages(events, cut.shadowed),
      hidden: cut.shadowed.length,
      tail: Math.max(0, events.length - 1 - seq),
      files: files.files,
      skipped: files.skipped,
    }
  }

  /**
   * 执行：追加标记 + 按需还原文件。
   * @param request - `{ sessionId, seq, restoreFiles }`。
   */
  async function apply({ sessionId, seq, restoreFiles }) {
    if (typeof sessionId !== 'string' || sessionId === '') throw failure(400, '未指定会话。')
    if (!Number.isSafeInteger(seq) || seq < 0) throw failure(400, '未指定回撤到的消息。')
    const session = liveSession(sessionId)
    if (session === undefined) throw failure(409, '会话没有在运行中的 Host 里加载。')
    await settle(sessionId)
    const events = session.snapshotEvents()
    const { cut } = targetOf(events, seq)
    const marker = session.append('user/message', markerData(), markerOptions(cut))
    const restored = restoreFiles === true ? await store.restore(sessionId, seq) : { restored: 0, deleted: 0, notes: [] }
    return {
      markerSeq: marker.seq,
      hidden: cut.shadowed.length,
      cuts: cutsOf(session.snapshotEvents()),
      restored: restored.restored,
      deleted: restored.deleted,
      notes: restored.notes,
    }
  }

  /**
   * 一个会话已经发生过的回撤区间，界面冷加载时用来隐藏被撤的行。
   * @param sessionId - 会话 id。
   */
  async function cuts(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw failure(400, '未指定会话。')
    return cutsOf(await eventsOf(sessionId))
  }

  /**
   * 工具执行前抓写前快照。
   * @param exec - 待执行的工具调用。
   */
  async function capture(exec) {
    const target = targetPath(exec)
    if (target === null) return
    const sessionId = exec?.agent?.session?.id
    const anchorSeq = exec?.agent?.session?.seq
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(anchorSeq)) return
    await store.capture({ sessionId, anchorSeq, target })
  }

  return { plan, apply, cuts, capture }
}

/**
 * 区间里用户自己发的消息条数（排除注入给模型的上下文消息与助手消息）。
 * @param events - 按 seq 连续排列的事件。
 * @param shadowed - 被替换的 surface 节点序号。
 * @returns 用户消息条数。
 */
function humanMessages(events, shadowed) {
  let count = 0
  for (const seq of shadowed) {
    const event = events[seq]
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    // 回撤标记本身也是 user/message，别把它算成一条对话。
    const text = Array.isArray(event.data.content) ? event.data.content.find((block) => block?.type === 'text')?.text : undefined
    if (text === MARKER_TEXT) continue
    count += 1
  }
  return count
}

/**
 * 一次工具调用会写哪个文件；不写文件的工具返回 null。
 * @param exec - 工具调用。
 */
function targetPath(exec) {
  const args = exec?.arguments
  if (args === null || typeof args !== 'object') return null
  if (exec.name === 'write') return typeof args.file_path === 'string' ? args.file_path : null
  if (exec.name === 'str_replace_editor') {
    if (args.command === 'view') return null
    return typeof args.path === 'string' ? args.path : null
  }
  return null
}
