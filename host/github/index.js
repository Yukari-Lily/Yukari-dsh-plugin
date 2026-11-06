/**
 * Github: persisted GitHub push credentials for the harness.
 *
 * The component owns a 0600 token file and a small git credential helper
 * scoped to `https://github.com`. The panel talks to this JSON API; the agent
 * uses ordinary `git push` through bash, which picks the helper up from the
 * include this component adds to the global git config.
 * @module yukari-dsh-plugin/github
 */
import path from 'node:path'
import { markMounted } from '../shared/mounted.js'
import { resolveDshHome } from '../shared/home.js'
import { migratePath } from '../shared/migrate.js'
import { LEGACY_DIRECTORY } from './lib/store.js'
import { GitHubController } from './lib/controller.js'
import { BODY_LIMITS, guardRoute, readJsonBody, sendJson } from '../shared/http.js'

/** JSON API prefix served to the Web panel. */
export const API_PATH = '/github/api'

/** Services this component needs. */
export const inject = ['webServer', 'connection']

/** Read the custom header as one string. */
function tokenHeader(req) {
  const raw = req.headers['x-yukari-github-token']
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : ''
}

/**
 * Register the Host half.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  markMounted(ctx, 'github')
  const log = (message) => {
    try {
      ctx.logger?.('github')?.warn?.(message)
    } catch {
      // A missing logger must not break the component.
    }
  }
  // Older versions kept this state under `yukari-github/`. Move it before the
  // controller resolves its paths, so a working token survives the rename.
  const dshHome = resolveDshHome()
  migratePath(path.join(dshHome, LEGACY_DIRECTORY), path.join(dshHome, 'github'))
  const controller = new GitHubController({ log })

  ctx.effect(
    async () => {
      await controller.init()
      return () => controller.dispose()
    },
    'yukari-github: lifecycle',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: guardRoute(ctx, async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')

          if (action === 'state') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'use GET' })
              return
            }
            sendJson(res, 200, { ok: true, state: await controller.state() })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'use POST' })
            return
          }
          const body = await readJsonBody(req, BODY_LIMITS.small)
          if (action === 'token') {
            sendJson(res, 200, { ok: true, state: await controller.saveToken(tokenHeader(req)) })
            return
          }
          if (action === 'verify') {
            sendJson(res, 200, { ok: true, state: await controller.verify() })
            return
          }
          if (action === 'repo') {
            sendJson(res, 200, { ok: true, repo: await controller.checkRepo(String(body.repo ?? '')) })
            return
          }
          if (action === 'install') {
            sendJson(res, 200, { ok: true, state: await controller.install() })
            return
          }
          if (action === 'clear') {
            sendJson(res, 200, { ok: true, state: await controller.clear() })
            return
          }
          sendJson(res, 404, { ok: false, error: `unknown action "${action}"` })
        }),
      }),
    `yukari-github: ${API_PATH}/*`,
  )
}
