/**
 * Shadowsocks egress proxy for the Harness.
 *
 * The Host half owns the proxy lifecycle and exposes it twice: a small JSON
 * API that the Web panel calls, and the `ss_proxy` agent tool. Both reach the
 * same {@link ProxyController} methods.
 *
 * While enabled, the local mixed proxy carries Node `fetch` (LLM, web, MCP),
 * child-process HTTP through the standard proxy variables, and Chromium
 * sessions launched afterwards.
 * @module @local/ss-proxy
 */
import { ProxyController } from './lib/controller.js'

/** JSON API prefix served to the Web panel. */
export const API_PATH = '/ssproxy/api'

/** Largest accepted request body. */
const MAX_BODY_BYTES = 64 * 1024

/** Services this plugin needs. */
export const inject = ['tools', 'webServer', 'connection']

/** Serialize one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
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

/** Node fields safe to return: the password stays on the Host. */
function publicNode(node) {
  const { password: _password, ...rest } = node
  return rest
}

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Register the Host half.
 * @param ctx - plugin context.
 * @param config - plugin row config used as first-run defaults.
 */
export function apply(ctx, config = {}) {
  if (ctx.root) ctx.root['yukari.proxy'] = true
  const log = (message) => {
    try {
      ctx.logger?.('ss-proxy')?.warn?.(message)
    } catch {
      // A missing logger must not break the proxy.
    }
  }
  const controller = new ProxyController({ config, log })

  ctx.effect(async () => {
    await controller.init()
    return () => controller.dispose()
  }, 'ss-proxy: lifecycle')

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'ss_proxy',
        description:
          'Control the Shadowsocks egress proxy. `enable` routes this process outbound HTTP (web fetch/search, MCP, LLM) and child-process HTTP through the node, and newly launched browser sessions use it too; `disable` restores direct access. `configure` changes the node, `import` accepts an ss:// link or a Shadowsocks JSON config, `test` probes the node with one real request, `status` reports the current route; `reset` forgets the stored node and password. The node password is stored in the local state file (mode 0600), so an enabled route comes back by itself after a Host restart.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'enable', 'disable', 'configure', 'test', 'import', 'reset'],
              description: 'Operation to perform.',
            },
            server: { type: 'string', description: 'Shadowsocks server host or IP, for `configure`. Omit to keep the current value.' },
            port: { type: 'number', description: 'Shadowsocks server port, for `configure`.' },
            method: {
              type: 'string',
              enum: ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305'],
              description: 'Shadowsocks AEAD method, for `configure`.',
            },
            password: { type: 'string', description: 'Shadowsocks password, for `configure`. Omit to keep the stored password (it is saved in the local state file, mode 0600).' },
            localPort: { type: 'number', description: 'Local proxy port (1024-65535), for `configure`.' },
            bypass: { type: 'string', description: 'Comma-separated host suffixes kept direct, for `configure`.' },
            uri: {
              type: 'string',
              description: 'An ss:// share link, or a Shadowsocks JSON config (Clash/subscription object, array, or several pasted objects), for `import`.',
            },
            apply: { type: 'boolean', description: 'For `import`, apply the parsed node immediately (default true).' },
            target: { type: 'string', description: 'host:port probe target for `test` (default www.gstatic.com:80).' },
          },
          required: ['action'],
        },
        output: {
          schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, state: { type: 'object' } } },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        timeoutMs: 60000,
        isConcurrencySafe: () => false,
        execute: async (args) => {
          const action = String(args?.action ?? '')
          try {
            if (action === 'status') return { ok: true, state: controller.state() }
            if (action === 'enable') return { ok: true, state: await controller.enable() }
            if (action === 'disable') return { ok: true, state: await controller.disable() }
            if (action === 'configure') {
              return {
                ok: true,
                state: await controller.configure({
                  server: args.server,
                  port: args.port,
                  method: args.method,
                  password: args.password,
                  localPort: args.localPort,
                  bypass: args.bypass,
                }),
              }
            }
            if (action === 'import') {
              const node = controller.parse(String(args.uri ?? ''))
              if (args.apply === false) return { ok: true, node: publicNode(node), state: controller.state() }
              const state = await controller.configure({
                server: node.server,
                port: node.port,
                method: node.method,
                password: node.password,
              })
              return { ok: true, node: publicNode(node), state }
            }
            if (action === 'reset') return { ok: true, state: await controller.reset() }
            if (action === 'test') {
              const result = await controller.test(args.target)
              return { ok: true, test: result, state: controller.state() }
            }
            throw new Error(`unknown action "${action}"`)
          } catch (error) {
            return { ok: false, error: messageOf(error), state: controller.state() }
          }
        },
      }),
    'ss-proxy: ss_proxy tool',
  )

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
            if (action === 'state') {
              if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'use GET' })
                return
              }
              sendJson(res, 200, { ok: true, state: controller.state() })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'use POST' })
              return
            }
            const body = await readJsonBody(req)
            if (action === 'enable') {
              sendJson(res, 200, { ok: true, state: await controller.enable() })
              return
            }
            if (action === 'disable') {
              sendJson(res, 200, { ok: true, state: await controller.disable() })
              return
            }
            if (action === 'configure') {
              sendJson(res, 200, { ok: true, state: await controller.configure(body) })
              return
            }
            if (action === 'test') {
              const test = await controller.test(body.target)
              sendJson(res, 200, { ok: true, test, state: controller.state() })
              return
            }
            if (action === 'import') {
              const node = controller.parse(String(body.uri ?? ''))
              if (body.apply === false) {
                sendJson(res, 200, { ok: true, node: publicNode(node), state: controller.state() })
                return
              }
              const state = await controller.configure({
                server: node.server,
                port: node.port,
                method: node.method,
                password: node.password,
              })
              sendJson(res, 200, { ok: true, node: publicNode(node), state })
              return
            }
            sendJson(res, 404, { ok: false, error: `unknown action "${action}"` })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: messageOf(error), state: controller.state() })
          }
        },
      }),
    `ss-proxy: POST ${API_PATH}/*`,
  )
}
