/**
 * Yukari Skills: install, inspect, edit and switch off agent skills.
 *
 * The skills themselves are a harness feature, not this plugin's invention:
 * `@deepseek-ai/dsh-skill-filesystem` discovers them in `$DSH_HOME/skills` (the
 * `user-dsh` root, rank 400), `@deepseek-ai/dsh-skill` merges them into one
 * catalog and `@deepseek-ai/dsh-tool-skill` renders that catalog to the model and
 * loads one body on demand. This component is only the caretaker of that
 * directory:
 *
 * - it lists the entries the provider would discover, and says why one it would
 *   skip is being skipped;
 * - it writes new ones (a flat `.md` or an unpacked `.zip` bundle) and edits
 *   existing bodies, validating frontmatter with the same grammar;
 * - it disables a skill by moving it to `$DSH_HOME/skills-disabled`, a directory
 *   no provider scans, and enables it by moving it back.
 *
 * No restart is involved in either direction: the provider watches the root, so
 * the next model step sees the new catalog. Nothing here reads `ctx.skills`,
 * because the registry visible from a host row only carries the global layer,
 * while filesystem discovery belongs to each agent preset's own layer.
 * @module yukari-dsh-plugin/skills
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { markMounted } from '../shared/mounted.js'
import { appError, attachmentHeader, guardRoute, readJsonBody, sendJson, streamToResponse } from '../shared/http.js'
import {
  MAX_TEXT_BYTES,
  archiveEntries,
  assertForm,
  assertKey,
  libraries,
  readSkill,
  removeSkill,
  saveSkill,
  scan,
  setEnabled,
} from './lib/library.js'
import { MAX_ARCHIVE_ENTRIES, MAX_UPLOAD_BYTES, installUpload, readRawBody } from './lib/upload.js'
import { writeZip } from '../shared/zip-writer.js'

/** JSON API prefix served to the panel. */
export const API_PATH = '/skills/api'

/** Services this component needs. */
export const inject = ['webServer', 'connection']

/** Body ceiling for the JSON actions; the editor's text has its own limit. */
const BODY_LIMIT = MAX_TEXT_BYTES + 64 * 1024

export async function apply(ctx) {
  const { root, disabledRoot } = libraries()
  markMounted(ctx, 'skills', { root })

  /** Every mutation runs alone: two clicks must not interleave moves and writes. */
  let queue = Promise.resolve()

  function serialized(operation) {
    const run = queue.then(operation, operation)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** One payload every view starts from. */
  async function state() {
    const items = await scan()
    return {
      ok: true,
      root,
      disabledRoot,
      items,
      limits: { uploadMb: Math.round(MAX_UPLOAD_BYTES / 1048576), textKb: Math.round(MAX_TEXT_BYTES / 1024), entries: MAX_ARCHIVE_ENTRIES },
    }
  }

  /** One entry from the panel's `key` / `form` pair. */
  function selection(url, body) {
    const key = assertKey(url?.searchParams?.get('key') ?? body?.key)
    const form = assertForm(url?.searchParams?.get('form') ?? body?.form)
    return { key, form }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: guardRoute(ctx, async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')

          if (req.method === 'GET' && (action === '' || action === 'state')) {
            sendJson(res, 200, await state())
            return
          }

          if (req.method === 'GET' && action === 'skill') {
            const { key, form } = selection(url)
            sendJson(res, 200, { ok: true, ...(await readSkill(key, form)) })
            return
          }

          if (req.method === 'GET' && action === 'download') {
            const { key, form } = selection(url)
            const { entries, item } = await archiveEntries(key, form)
            const base = item.name === '' ? key : item.name
            res.setHeader('x-content-type-options', 'nosniff')
            if (form === 'file') {
              const file = entries[0].path
              const info = await stat(file)
              res.statusCode = 200
              res.setHeader('content-type', 'text/markdown; charset=utf-8')
              res.setHeader('content-length', String(info.size))
              res.setHeader('content-disposition', attachmentHeader(`${base}.md`))
              await streamToResponse(createReadStream(file), res)
              return
            }
            res.statusCode = 200
            res.setHeader('content-type', 'application/zip')
            res.setHeader('content-disposition', attachmentHeader(`${base}.zip`))
            try {
              await writeZip(res, entries)
            } catch (error) {
              if (!res.headersSent) {
                res.removeHeader('content-type')
                res.removeHeader('content-disposition')
              }
              throw error
            }
            res.end()
            return
          }

          if (req.method === 'POST' && action === 'upload') {
            const filename = url.searchParams.get('filename') ?? ''
            const bytes = await readRawBody(req)
            const result = await serialized(() => installUpload({ bytes, filename }))
            sendJson(res, 200, { ok: true, ...result })
            return
          }

          if (req.method === 'POST') {
            const body = await readJsonBody(req, BODY_LIMIT)
            if (action === 'save') {
              const { key, form } = selection(undefined, body)
              const text = typeof body.text === 'string' ? body.text : ''
              const result = await serialized(() => saveSkill(key, form, text))
              sendJson(res, 200, { ok: true, ...result })
              return
            }
            if (action === 'enable' || action === 'disable') {
              const { key, form } = selection(undefined, body)
              const item = await serialized(() => setEnabled(key, form, action === 'enable'))
              sendJson(res, 200, { ok: true, item })
              return
            }
            if (action === 'delete') {
              const { key, form } = selection(undefined, body)
              sendJson(res, 200, { ok: true, ...(await serialized(() => removeSkill(key, form))) })
              return
            }
          }

          sendJson(res, 404, { ok: false, error: `未知的操作：${req.method} ${action === '' ? '/' : action}` })
        }),
      }),
    'yukari-skills: routes',
  )

  ctx.logger?.info?.('yukari-skills: %s', path.join(API_PATH, 'state'))
}
