/**
 * 会话回撤：原地把对话退回某条用户消息，并可一并还原那之后工具改过的文件。
 *
 * 回撤靠一条追加的标记消息（`user/message` + `surfaceOp.replace`）把目标之后的
 * 内容从模型可见的 surface 上切掉；日志只增不改，不开分支、不换会话 id。
 * 文件回退靠工具执行前抓的写前快照。
 *
 * Host 半只提供三件事：查已有回撤区间、预览、执行；客户端半负责按钮与隐藏。
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

  // 工具执行前抓写前快照：等到它写完再放行，快照才是"写之前"。
  ctx.effect(() => {
    const handler = async (exec, next) => {
      try {
        await rewind.capture(exec)
      } catch {
        // 抓快照失败不能让工具调不动；界面会在结果里说明没有快照。
      }
      return next()
    }
    return ctx.on('tools/pre-execute', handler, { prepend: true })
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

          if (action === 'plan' || action === 'apply') {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: '请使用 POST。' })
              return
            }
            const body = await readJsonBody(req)
            const request = {
              sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
              seq: Number.isSafeInteger(body.seq) ? body.seq : NaN,
              restoreFiles: body.restoreFiles === true,
            }
            sendJson(res, 200, { ok: true, ...(action === 'plan' ? await rewind.plan(request) : await rewind.apply(request)) })
            return
          }

          sendJson(res, 404, { ok: false, error: `未知操作「${action}」` })
        }),
      }),
    'yukari-rewind: http',
  )
}
