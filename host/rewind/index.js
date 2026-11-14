/**
 * 会话回撤：原地把对话退回某条用户消息，并可一并还原那之后工具改过的文件。
 *
 * 回撤靠一条追加的标记消息（`user/message` + `surfaceOp.replace`）把目标之后的
 * 内容从模型可见的 surface 上切掉；日志只增不改，不开分支、不换会话 id。
 * 文件回退靠工具执行前抓的写前快照。
 *
 * Host 半只提供四件事：查已有回撤区间、预览、执行、处理失败的还原；客户端半
 * 负责按钮与隐藏。
 * @module yukari-dsh-plugin/rewind
 */

import path from 'node:path'
import { markMounted } from '../shared/mounted.js'
import { guardRoute, readJsonBody, sendJson } from '../shared/http.js'
import { resolveDshHome } from '../shared/home.js'
import { createRewind } from './lib/controller.js'
import { createSnapshotStore } from './lib/store.js'

/** Route prefix the client calls. */
export const API_PATH = '/rewind/api'

/** Services this component needs. */
export const inject = ['sessions', 'sessionPersistence', 'agents', 'webServer', 'connection']

/** 快照仓库在 `$DSH_HOME` 下的目录名。 */
const STORE_DIR = 'rewind'

/**
 * Register the Host half.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const root = path.join(resolveDshHome(), STORE_DIR)
  const store = createSnapshotStore({ root })
  const rewind = createRewind({ ctx, store })
  markMounted(ctx, 'rewind', { storage: root })

  // 快照挂在 tools/execute 上，包住工具本体：宿主先跑 tools/pre-execute 的审批与
  // 守卫，被拒的调用根本到不了这里，所以被策略拒绝的路径不会进快照。写前抓、
  // 写后确认，压着工具本体执行。
  ctx.effect(() => {
    const handler = async (exec, next) => {
      const receipts = await rewind.capture(exec).catch((error) => {
        warn(ctx, '抓取写前快照失败', error)
        return []
      })
      let result
      try {
        result = await next()
      } catch (error) {
        await confirmAfter(rewind, ctx, exec, receipts, { isError: true })
        throw error
      }
      await confirmAfter(rewind, ctx, exec, receipts, result)
      return result
    }
    return ctx.on('tools/execute', handler, { prepend: true })
  }, 'yukari-rewind: capture')

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: guardRoute(ctx, async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')

          if (action === 'cuts') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: '请使用 GET。' })
              return
            }
            const sessionId = url.searchParams.get('sessionId') ?? ''
            sendJson(res, 200, { ok: true, cuts: await rewind.cuts(sessionId) })
            return
          }

          if (action === 'plan' || action === 'apply' || action === 'restore') {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: '请使用 POST。' })
              return
            }
            const body = await readJsonBody(req)
            const request = {
              sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
              seq: Number.isSafeInteger(body.seq) ? body.seq : NaN,
              restoreFiles: body.restoreFiles === true,
              planToken: typeof body.planToken === 'string' ? body.planToken : undefined,
              mode: body.mode === 'rollback' ? 'rollback' : 'continue',
            }
            const payload =
              action === 'plan' ? await rewind.plan(request) : action === 'apply' ? await rewind.apply(request) : await rewind.resume(request)
            sendJson(res, 200, { ok: true, ...payload })
            return
          }

          sendJson(res, 404, { ok: false, error: `未知操作「${action}」` })
        }),
      }),
    'yukari-rewind: http',
  )
}

/**
 * 执行后确认捕获。失败本身不影响工具调用，但要留下痕迹，不能静默丢掉。
 * @param rewind - 回撤编排。
 * @param ctx - plugin context，用它的 logger。
 * @param exec - 已执行的工具调用。
 * @param receipts - 捕获回执。
 * @param result - 工具结果。
 */
async function confirmAfter(rewind, ctx, exec, receipts, result) {
  try {
    await rewind.confirm(exec, receipts, result)
  } catch (error) {
    warn(ctx, '确认写前快照失败', error)
  }
}

/** 打一条警告，没有 logger 就退回 console。 */
function warn(ctx, message, error) {
  const detail = error instanceof Error ? error.message : String(error)
  if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`[yukari-rewind] ${message}：${detail}`)
  else console.warn(`[yukari-rewind] ${message}：${detail}`)
}
