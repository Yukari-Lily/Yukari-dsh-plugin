/**
 * Chat manager bundle: one Host half that inventories stored chats and can
 * delete them, plus one Client half that renders it as a sidebar panel.
 *
 * The Host exposes the same three operations twice — as a small JSON API the
 * panel calls, and as agent tools with matching meaning — so the panel and the
 * model never disagree about what a chat list or a delete is.
 *
 * @module @local/chat-manager
 */
import { markMounted } from '../shared/mounted.js'
import { API_PATH, createAdmin, messageOf } from './lib/admin.js'

export { API_PATH }

/** Largest accepted request body. */
const MAX_BODY_BYTES = 64 * 1024

/** Rows one inventory tool answer carries. */
const TOOL_ROW_LIMIT = 200

/** Services this bundle needs. */
export const inject = ['sessionPersistence', 'sessionQuery', 'sessions', 'webServer', 'connection', 'tools']

/** Serialize one JSON response. */
function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/** Read a bounded JSON body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** Trim one chat row to the shape an agent tool answer needs. */
function toolRow(row) {
  return {
    id: row.id,
    title: row.title ?? '(untitled)',
    archived: row.archived === true,
    live: row.live === true,
    running: row.running === true,
    updatedAt: new Date(row.updatedAt).toISOString(),
    bytes: typeof row.bytes === 'number' ? row.bytes : 0,
    events: typeof row.events === 'number' ? row.events : 0,
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
  }
}

/** Render one inventory answer as a compact table. */
function renderInventory(_args, value) {
  const lines = [
    `${value.total} chats · ${value.archived} archived · ${value.live} open · ${value.bytes} bytes stored`,
  ]
  for (const row of value.sessions) {
    const flags = [row.archived ? 'archived' : 'active', row.live ? 'open' : 'closed']
    lines.push(`- ${row.title} [${flags.join(', ')}] ${row.id} · ${row.bytes}B`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Register the Host half.
 * @param ctx - plugin context.
 * @param config - sessionsRoot and titleBudget.
 */
export function apply(ctx, config = {}) {
  markMounted(ctx, 'chats')
  const admin = createAdmin({ ctx, config })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: async (req, res) => {
          const rejection = ctx.connection.requestRejection(req)
          if (rejection !== undefined && rejection !== null) {
            res.statusCode = rejection
            res.end()
            return
          }
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')
          try {
            if (action === '' || action === 'state') {
              if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'use GET' })
                return
              }
              sendJson(res, 200, { ok: true, state: await admin.snapshot() })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'use POST' })
              return
            }
            const body = await readJsonBody(req)
            if (action === 'delete') {
              const result = await admin.remove({
                ids: body.ids,
                force: body.force === true,
                deleteFiles: body.deleteFiles === true,
                deleteWorkspaceDir: body.deleteWorkspaceDir === true,
                workspaceId: body.workspaceId,
                workspacePath: body.workspacePath,
              })
              sendJson(res, 200, { ok: true, ...result })
              return
            }
            if (action === 'archive') {
              const result = await admin.setArchived({ id: body.id, archived: body.archived === true })
              sendJson(res, 200, { ok: true, ...result })
              return
            }
            sendJson(res, 404, { ok: false, error: `unknown action "${action}"` })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: messageOf(error) })
          }
        },
      }),
    `chat-manager: ${API_PATH}/*`,
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'chat_inventory',
        description:
          'List the chats stored on this Host: id, title, whether each is archived, still open in this process, and how much it occupies on disk. Use it before deleting chats, and to answer "what chats do I have".',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            filter: {
              type: 'string',
              enum: ['all', 'active', 'archived'],
              description: 'Which chats to return; defaults to all.',
            },
            query: { type: 'string', description: 'Case-insensitive match on title, id, working directory, or workspace.' },
            limit: { type: 'integer', description: `Maximum rows to return; defaults to 50, capped at ${TOOL_ROW_LIMIT}.` },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['total', 'archived', 'live', 'bytes', 'sessions'],
            properties: {
              total: { type: 'integer', description: 'Chats matching the filter.' },
              archived: { type: 'integer', description: 'Chats currently in the archive set.' },
              live: { type: 'integer', description: 'Chats loaded in this Host process.' },
              bytes: { type: 'integer', description: 'Bytes those chats occupy on disk.' },
              sessions: {
                type: 'array',
                description: 'Matching chats, newest activity first.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'title', 'archived', 'live', 'running', 'updatedAt', 'bytes', 'events'],
                  properties: {
                    id: { type: 'string', description: 'Session id; the key chat_delete takes.' },
                    title: { type: 'string', description: 'Latest logged title, or "(untitled)".' },
                    archived: { type: 'boolean', description: 'Whether the chat is archived.' },
                    live: { type: 'boolean', description: 'Whether the chat is loaded in this process.' },
                    running: { type: 'boolean', description: 'Whether the chat currently has a running turn.' },
                    updatedAt: { type: 'string', description: 'ISO instant of the last artifact change.' },
                    bytes: { type: 'integer', description: 'Artifact size in bytes.' },
                    events: { type: 'integer', description: 'Logical event count.' },
                    cwd: { type: 'string', description: 'Working directory the chat was created in, when known.' },
                  },
                },
              },
            },
          },
          render: renderInventory,
        },
        async execute(args = {}) {
          const state = await admin.snapshot()
          const filter = args.filter === 'active' || args.filter === 'archived' ? args.filter : 'all'
          const needle = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
          const requested = Number.isFinite(Number(args.limit)) ? Math.floor(Number(args.limit)) : 50
          const limit = Math.min(Math.max(requested, 1), TOOL_ROW_LIMIT)
          const rows = state.sessions.filter((row) => {
            if (filter === 'active' && row.archived) return false
            if (filter === 'archived' && !row.archived) return false
            if (needle === '') return true
            const haystack = [row.title ?? '', row.id, row.cwd ?? '', row.workspaceTitle ?? ''].join('\n').toLowerCase()
            return haystack.includes(needle)
          })
          const visible = rows.slice(0, limit).map(toolRow)
          return {
            total: rows.length,
            archived: rows.filter((row) => row.archived).length,
            live: rows.filter((row) => row.live).length,
            bytes: rows.reduce((sum, row) => sum + (typeof row.bytes === 'number' ? row.bytes : 0), 0),
            sessions: visible,
          }
        },
      }),
    'chat-manager: chat_inventory tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'chat_delete',
        description:
          'Permanently delete stored chats by Session id: removes the chat artifact from the Host, then drops the id from workspace accounting, the archive set, and the pin set. Archived chats are deleted the same way. A chat still open in this process is refused unless force is true.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['ids'],
          properties: {
            ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Session ids to delete, as returned by chat_inventory.',
            },
            force: {
              type: 'boolean',
              description: 'Also delete chats currently loaded in this Host process. Defaults to false.',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['deleted', 'ids', 'failed'],
            properties: {
              deleted: { type: 'integer', description: 'How many chats were removed.' },
              ids: { type: 'array', items: { type: 'string' }, description: 'Ids that were removed.' },
              failed: {
                type: 'array',
                description: 'Ids left in place, each with its reason.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'reason'],
                  properties: {
                    id: { type: 'string', description: 'Session id that stayed.' },
                    reason: { type: 'string', description: 'unknown, live, in-memory, no-artifact, unsafe-path, or an errno message.' },
                  },
                },
              },
            },
          },
          render: (_args, value) => {
            const head = `deleted ${value.deleted} chat${value.deleted === 1 ? '' : 's'}`
            const tail = value.failed.length === 0
              ? ''
              : `\nkept ${value.failed.length}: ${value.failed.map((item) => `${item.id} (${item.reason})`).join(', ')}`
            return [{ type: 'text', text: head + tail }]
          },
        },
        async execute(args = {}) {
          const result = await admin.remove({ ids: args.ids, force: args.force === true })
          return { deleted: result.deleted, ids: result.ids, failed: result.failed }
        },
      }),
    'chat-manager: chat_delete tool',
  )
}
