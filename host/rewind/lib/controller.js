/**
 * 回撤的编排：查事件、校验目标、等空闲、还原文件、追加标记。
 *
 * 会话本身不拷贝、不新开：追加一条标记消息，用 surface 替换把"目标消息到末尾"
 * 整段从模型可见历史里切掉；文件由写前快照写回。日志永远只增不改。
 *
 * 顺序刻意是"先校验目标、再停回合、再还原文件、最后切对话"：
 * 目标不合法时不该打断正在跑的回合；文件没还原成功时不该出现"对话切了、文件还在"。
 * @module yukari-dsh-plugin/rewind/controller
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import { messageOf } from '../../shared/http.js'
import { assertSessionId } from './safe-path.js'
import { MARKER_TEXT, markerData, markerOptions } from './marker.js'
import { cutsOf, planCut } from './surface.js'

/** 等一次运行中的回合停下来最多多久。 */
const IDLE_TIMEOUT_MS = 15000

/** 轮询间隔。 */
const IDLE_POLL_MS = 200

/** 预览结果的存活时间：确认面板放太久就要求重新预览。 */
const PLAN_TTL_MS = 10 * 60 * 1000

/** 最多记住多少份预览结果。 */
const MAX_PLANS = 200

/** 带状态码的错误。 */
function failure(status, message, code, params) {
  const error = new Error(message)
  error.status = status
  if (typeof code === 'string' && code !== '') error.appCode = code
  if (params !== undefined && params !== null) error.params = params
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

/** 一条事件里第一个文本块的正文。 */
function textOfEvent(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return null
  const block = content.find((item) => item?.type === 'text')
  return typeof block?.text === 'string' ? block.text : null
}

/**
 * 事件是不是操作者自己发的消息。
 *
 * 宿主的压缩检查点（`compact-checkpoint`）、运行时上下文注入（`runtime-context`）、
 * 目标与计划消息、智能体互发消息都是 `user/message` 且能带替换区间，单看事件类型
 * 不够。只有 `source.kind === 'user'`（含界面里的 `user-rpc`）才是人发的；标记
 * 自己的来源类型是 `rewind-marker`，正文相同的老标记也一并排除。
 * @param event - 任意事件。
 * @returns 是否可以当作回撤目标。
 */
function isHumanUserMessage(event) {
  if (event?.type !== 'user/message') return false
  const source = event.data?.source
  if (source === null || typeof source !== 'object' || source.kind !== 'user') return false
  if (event.data?.role !== undefined && event.data.role !== 'user') return false
  return textOfEvent(event) !== MARKER_TEXT
}

/** 宿主以 user/message 记下、但不属于对话轮次的来源。 */
const INTERNAL_USER_SOURCES = new Set(['compact-checkpoint', 'runtime-context', 'compaction'])

/** 一次工具调用会写哪些文件；不写文件的工具返回空数组。 */
function writeTargets(exec) {
  const args = exec?.arguments
  if (args === null || typeof args !== 'object') return []
  if (exec.name === 'write' || exec.name === 'edit') {
    return typeof args.file_path === 'string' && args.file_path !== '' ? [args.file_path] : []
  }
  if (exec.name === 'str_replace_editor') {
    if (args.command === 'view') return []
    return typeof args.path === 'string' && args.path !== '' ? [args.path] : []
  }
  if (exec.name === 'apply_patch') return patchTargets(args.input)
  return []
}

/**
 * 从 Codex 风格补丁文本里取出所有会被写的路径（含 Move 的目标）。
 * @param input - `apply_patch` 的 `input` 参数。
 * @returns 去重后的原始路径，相对路径按会话工作目录解析。
 */
function patchTargets(input) {
  if (typeof input !== 'string') return []
  const found = []
  for (const line of input.split('\n')) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/u.exec(line.trimEnd())
    if (match !== null) found.push(match[1])
  }
  return [...new Set(found)]
}

/**
 * 建回撤编排。
 * @param args - 插件上下文与快照仓库。
 * @returns plan / apply / cuts / capture / confirm / resume。
 */
export function createRewind({ ctx, store }) {
  const sessions = optionalService(ctx, 'sessions')
  const persistence = optionalService(ctx, 'sessionPersistence')
  const agents = optionalService(ctx, 'agents')

  /** 预览结果的指纹，apply 用它判断确认之后会话有没有变。 */
  const plans = new Map()

  /** 当前加载着的会话。 */
  const liveSession = (sessionId) => (sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined)

  /** 一个会话的事件；没加载就读磁盘。 */
  async function eventsOf(sessionId) {
    assertSessionId(sessionId)
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

  /** 会话的工作区：捕获与还原都以它为边界。 */
  function workspaceRootOf(session) {
    const policy = optionalService(ctx, 'sandboxPolicy')
    if (typeof policy?.resolve === 'function') {
      const resolved = policy.resolve({ session })
      if (typeof resolved?.workspaceRoot === 'string' && resolved.workspaceRoot !== '') return resolved.workspaceRoot
    }
    const cwd = session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  }

  /** 会话的工作目录：相对路径按它解析，与文件工具的解析口径一致。 */
  async function workingDirectoryOf(exec) {
    const service = optionalService(ctx, 'workingDirectory')
    if (typeof service?.ensure === 'function') {
      try {
        const cwd = await service.ensure(exec.agent, exec.signal)
        if (typeof cwd === 'string' && cwd !== '') return cwd
      } catch {
        // 取不到工作目录时退回会话头的 cwd，别让一次捕获整体失败。
      }
    }
    const cwd = exec?.agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  }

  /**
   * 写回通道：判权、原子发布、删文件都交给宿主文件系统。
   *
   * 不走裸 fs 是这次修复的核心——`ctx.fs.writeText` 会按当前会话的沙箱模式判定
   * （只读模式直接拒绝、workspace-write 要求目标在可写根内），并且是原子发布。
   */
  function hostIo(session) {
    const files = optionalService(ctx, 'fs')
    if (files === undefined || typeof files.resolve !== 'function' || typeof files.writeText !== 'function') return undefined
    const policy = optionalService(ctx, 'sandboxPolicy')
    const resolvedPolicy = typeof policy?.resolve === 'function' ? policy.resolve({ session }) : undefined
    return {
      async write(target, bytes, signal) {
        const text = bytes.toString('utf8')
        if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('快照内容不是 UTF-8 文本，无法写回。')
        const handle = await files.resolve(target, signal === undefined ? undefined : { signal })
        await files.writeText(handle, text, undefined, signal, resolvedPolicy)
      },
      async remove(target, signal) {
        const handle = await files.resolve(target, signal === undefined ? undefined : { signal })
        if (typeof files.stat === 'function' && (await files.stat(handle, signal)) === undefined) return
        await files.deleteFile(handle, undefined, signal, resolvedPolicy)
      },
    }
  }

  /** 目标必须是操作者自己发的、还在 surface 上的消息。 */
  function targetOf(events, seq) {
    const event = events[seq]
    if (event === undefined) throw failure(409, '找不到这条消息。')
    if (event.type !== 'user/message') throw failure(409, '只能回撤到用户消息。', 'rewind-target-not-user')
    // 宿主把自己的注入也记成 user/message：压缩检查点、运行时上下文、以及本
    // 组件写的回撤标记。它们不是对话轮次，回撤到那里会切在句子中间，所以先按
    // 来源判定，不让 surface 计算给出"这条消息已经不在对话里"这种误导。
    const source = event?.data?.source
    const kind = typeof source?.kind === 'string' ? source.kind : ''
    if (INTERNAL_USER_SOURCES.has(kind) || textOfEvent(event) === MARKER_TEXT) {
      throw failure(409, '只能回撤到自己发送的消息，注入的上下文与回撤标记不能作为目标。', 'rewind-target-internal')
    }
    if (!isHumanUserMessage(event)) throw failure(409, '只能回撤到自己发送的消息，注入的上下文与回撤标记不能作为目标。', 'rewind-target-internal')
    const cut = planCut(events, seq)
    if (cut === null) throw failure(409, '这条消息已经不在当前对话里。', 'rewind-target-gone')
    if (cut.shadowed.length === 0) throw failure(409, '这条消息之后没有内容。', 'rewind-target-empty')
    return { event, cut }
  }

  /**
   * 预览指纹：只认"回撤到哪条消息"。
   *
   * 回撤范围是"目标消息到 surface 末尾"，日志在确认之后继续增长是常态：回合还在
   * 跑、助手刚落一条消息、操作者又发了一句。那些内容本来就该一起撤掉，把它们算进
   * 指纹只会让"停掉回合再回撤"永远失败（旧实现连日志长度一起算，于是每次停回合
   * 都会报"回撤范围与确认时不同"）。真正需要挡住的是目标本身变了：那条消息被
   * 后来的回撤标记盖掉时，`targetOf` 会先报"这条消息已经不在当前对话里"。
   * @param sessionId - 会话 id。
   * @param seq - 目标消息的序号。
   * @param events - 日志事件。
   * @returns 指纹。
   */
  function signatureOf(sessionId, seq, events) {
    const target = events[seq]
    return createHash('sha1')
      .update([sessionId, seq, target?.type ?? '', textOfEvent(target) ?? ''].join('|'))
      .digest('hex')
  }

  const planKey = (sessionId, seq) => `${sessionId}\u0000${seq}`

  /** 记住一份预览结果，超量的先丢最早的。 */
  function rememberPlan(key, value) {
    plans.delete(key)
    plans.set(key, value)
    while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value)
  }

  /** 取一份还没过期的预览结果：`undefined` 表示没有，`null` 表示已过期。 */
  function peekPlan(key) {
    const stored = plans.get(key)
    if (stored === undefined) return undefined
    if (Date.now() - stored.at > PLAN_TTL_MS) {
      plans.delete(key)
      return null
    }
    return stored
  }

  /**
   * 预览：回撤会切掉多少、动哪些文件。
   * @param request - `{ sessionId, seq }`。
   */
  async function plan({ sessionId, seq }) {
    assertSessionId(sessionId)
    if (!Number.isSafeInteger(seq) || seq < 0) throw failure(400, '未指定回撤到的消息。')
    const events = await eventsOf(sessionId)
    const { cut } = targetOf(events, seq)
    const session = liveSession(sessionId)
    const files = await store.planRestore(sessionId, seq, { workspaceRoot: session === undefined ? undefined : workspaceRootOf(session) })
    const signature = signatureOf(sessionId, seq, events)
    rememberPlan(planKey(sessionId, seq), { signature, at: Date.now() })
    return {
      startSeq: cut.startSeq,
      endSeq: cut.endSeq,
      // 面板拿它判断确认期间会话有没有变化；apply 会核对同一个值。
      planToken: signature,
      // 界面显示的是"撤下几条对话"，也就是区间里用户自己发的消息条数；
      // surface 节点数与屏幕上行数都不直观（一次对话可能带很多工具调用行）。
      human: humanMessages(events, cut.shadowed),
      hidden: cut.shadowed.length,
      tail: Math.max(0, events.length - 1 - seq),
      files: files.files,
      skipped: files.skipped,
      duplicates: files.duplicates,
    }
  }

  /** 还原文件；没有宿主文件系统时不写任何东西，直接报错。 */
  async function restoreFilesFor(sessionId, seq, session) {
    const io = hostIo(session)
    if (io === undefined) throw failure(409, '宿主文件系统不可用，无法还原文件。', 'rewind-no-fs')
    return store.restore(sessionId, seq, { workspaceRoot: workspaceRootOf(session), io })
  }

  /**
   * 执行：按需还原文件，然后追加标记。
   * @param request - `{ sessionId, seq, restoreFiles, planToken }`。
   */
  async function apply({ sessionId, seq, restoreFiles, planToken }) {
    assertSessionId(sessionId)
    if (!Number.isSafeInteger(seq) || seq < 0) throw failure(400, '未指定回撤到的消息。')
    const session = liveSession(sessionId)
    if (session === undefined) throw failure(409, '会话没有在运行中的 Host 里加载。', 'rewind-not-loaded')
    // 先确认目标合法再打断回合：不合法的目标不该把正在跑的回合停掉。
    targetOf(session.snapshotEvents(), seq)
    const key = planKey(sessionId, seq)
    const stored = peekPlan(key)
    if (typeof planToken === 'string' && planToken !== '') {
      // 只认预览端点发出去的标识：重新算一个哈希并不能证明用户看过这个范围。
      if (stored === undefined || stored === null || stored.signature !== planToken) {
        throw failure(409, '预览已失效，请重新预览后再回撤。', 'rewind-stale')
      }
    }
    await settle(sessionId)
    // 停回合期间日志会继续增长（助手最后一条消息、被取消的工具结果），那正是操作者
    // 想一起撤掉的部分。只要目标消息还在 surface 上，范围就仍然是"它到末尾"。
    const after = session.snapshotEvents()
    const current = targetOf(after, seq)
    // 文件先还原、成功后再切对话：失败时会话保持不动，可以继续或回滚。
    const files =
      restoreFiles === true
        ? await restoreFilesFor(sessionId, seq, session)
        : { restored: 0, deleted: 0, skipped: [], failed: [], notes: [], journal: null }
    if (files.failed.length > 0) {
      const detail = files.failed.map((item) => `${item.path}：${item.reason}`).join('；')
      throw failure(409, `还原文件失败（${files.failed.length} 个）：${detail}。对话未回撤，可继续或回滚已还原的文件。`, 'rewind-restore-failed', { count: files.failed.length })
    }
    const marker = session.append('user/message', markerData(current.cut), markerOptions(current.cut))
    plans.delete(key)
    return {
      markerSeq: marker.seq,
      hidden: current.cut.shadowed.length,
      cuts: cutsOf(session.snapshotEvents()),
      restored: files.restored,
      deleted: files.deleted,
      skipped: files.skipped,
      notes: files.notes,
    }
  }

  /**
   * 处理一次失败的还原：继续剩下的条目，或把已经写下去的内容回滚。
   * @param request - `{ sessionId, seq, mode: 'continue' | 'rollback' }`。
   */
  async function resume({ sessionId, seq, mode }) {
    assertSessionId(sessionId)
    if (!Number.isSafeInteger(seq) || seq < 0) throw failure(400, '未指定回撤到的消息。')
    const session = liveSession(sessionId)
    if (session === undefined) throw failure(409, '会话没有在运行中的 Host 里加载。', 'rewind-not-loaded')
    const io = hostIo(session)
    if (io === undefined) throw failure(409, '宿主文件系统不可用，无法处理文件还原。')
    if (mode === 'rollback') {
      const result = await store.rollback(sessionId, seq, { io })
      return {
        rolledBack: result.reverted,
        failed: result.failed,
        notes: result.failed.map((item) => `回滚失败 ${item.path}：${item.reason}`),
      }
    }
    const result = await store.restore(sessionId, seq, { workspaceRoot: workspaceRootOf(session), io })
    return { restored: result.restored, deleted: result.deleted, skipped: result.skipped, failed: result.failed, notes: result.notes }
  }

  /**
   * 一个会话已经发生过的回撤区间，界面冷加载时用来隐藏被撤的行。
   * @param sessionId - 会话 id。
   */
  async function cuts(sessionId) {
    assertSessionId(sessionId)
    return cutsOf(await eventsOf(sessionId))
  }

  /**
   * 工具执行前抓写前快照。挂在 `tools/execute` 上：此时审批与守卫都已经通过。
   * @param exec - 待执行的工具调用。
   * @returns 每个目标的捕获回执，供调用方判断跳过原因。
   */
  async function capture(exec) {
    const session = exec?.agent?.session
    const sessionId = session?.id
    const anchorSeq = session?.seq
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(anchorSeq)) return []
    const targets = writeTargets(exec)
    if (targets.length === 0) return []
    const workspaceRoot = workspaceRootOf(session)
    const cwd = await workingDirectoryOf(exec)
    const receipts = []
    for (const entry of targets) {
      if (!path.isAbsolute(entry) && typeof cwd !== 'string') {
        receipts.push({ target: entry, skipped: 'no-cwd' })
        continue
      }
      const target = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry)
      receipts.push({ target, ...(await store.capture({ sessionId, anchorSeq, workspaceRoot, target })) })
    }
    return receipts
  }

  /**
   * 工具执行完之后确认：失败且文件仍不存在的"原本没有"快照要撤掉。
   * @param exec - 已执行完的工具调用。
   * @param receipts - `capture` 的回执。
   * @param result - 工具结果，`isError` 表示失败。
   */
  async function confirm(exec, receipts, result) {
    const session = exec?.agent?.session
    const sessionId = session?.id
    const anchorSeq = session?.seq
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(anchorSeq)) return { dropped: 0 }
    const targets = (Array.isArray(receipts) ? receipts : [])
      .filter((receipt) => receipt.stored === true && receipt.existed === false)
      .map((receipt) => receipt.target)
    return store.confirm({ sessionId, anchorSeq, targets, failed: result?.isError === true })
  }

  return { plan, apply, resume, cuts, capture, confirm }
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
    if (isHumanUserMessage(events[seq])) count += 1
  }
  return count
}
