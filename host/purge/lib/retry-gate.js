/**
 * 拒答重试的门闸：决定一个会话此刻是否还能被二次提问。
 *
 * 三条条件缺一不可：条目由最近一次组装写入（过期即失效）、会话当前仍在
 * 无限制预设上（切走预设立刻失效）、条目数量有上限。只按会话号放行会让
 * 关掉模式之后的同进程会话继续被拦截，也会让长期运行的进程无限攒条目。
 *
 * @module @local/yukari-purge/lib/retry-gate
 */
import { isUnrestrictedSession } from './rewriter.js'

/** 条目上限：与旧实现一致，超出后淘汰最早写入的一条。 */
export const SESSION_CAP = 500

/**
 * 条目存活时间。
 *
 * 每个模型请求之前宿主都会重新组装一次提示词，条目随之刷新；所以真正需要
 * 重试的会话一定是刚组装过的。半小时只是给“组装后长时间无请求”的会话兜底。
 */
export const RETRY_TTL_MS = 30 * 60 * 1000

/**
 * 创建一个门闸。
 *
 * @param options - `cap`、`ttlMs`、`now`（测试用时钟）。
 * @returns `note(context)`、`isEligible(sessionId)`、`forget(sessionId)`、`size`。
 */
export function createRetryGate(options = {}) {
  const cap = options.cap ?? SESSION_CAP
  const ttlMs = options.ttlMs ?? RETRY_TTL_MS
  const clock = options.now ?? Date.now
  /** 会话号 → 最近一次组装的上下文与时间。 */
  const sessions = new Map()

  function prune(now) {
    for (const [id, entry] of sessions) {
      if (now - entry.at > ttlMs) sessions.delete(id)
    }
  }

  return {
    /**
     * 记录一次组装。
     *
     * @param context - 组装上下文（带 agent/session）。
     * @returns 是否记录了条目；没有会话号时不记录。
     */
    note(context) {
      const session = context?.agent?.session ?? context?.session
      const id = session?.id
      if (typeof id !== 'string' || id === '') return false
      const now = clock()
      if (!sessions.has(id)) {
        prune(now)
        if (sessions.size >= cap) {
          const oldest = sessions.keys().next().value
          if (oldest !== undefined) sessions.delete(oldest)
        }
      }
      sessions.set(id, { at: now, context })
      return true
    },

    /**
     * 会话此刻能否被重试。
     *
     * @param sessionId - 请求里的会话号。
     * @returns 条目未过期且会话仍在无限制预设上才为 true。
     */
    isEligible(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      const entry = sessions.get(sessionId)
      if (entry === undefined) return false
      if (clock() - entry.at > ttlMs) {
        sessions.delete(sessionId)
        return false
      }
      // 预设切走后改写不再注入，重试也必须同时停掉。
      if (!isUnrestrictedSession(entry.context)) {
        sessions.delete(sessionId)
        return false
      }
      return true
    },

    /** 预设切换或智能体销毁时立即移除。 */
    forget(sessionId) {
      if (typeof sessionId !== 'string') return
      sessions.delete(sessionId)
    },

    get size() {
      return sessions.size
    },
  }
}
