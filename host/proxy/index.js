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
import { markMounted } from '../shared/mounted.js'
import { ProxyController } from './lib/controller.js'
import { guardRoute, readJsonBody, sendJson, messageOf } from '../shared/http.js'

/** JSON API prefix served to the Web panel. */
export const API_PATH = '/ssproxy/api'

/** Services this plugin needs. */
export const inject = ['tools', 'webServer', 'connection']

/** Turn any thrown value into a message. */
/**
 * Resolve a tool's `id` / `name` argument to a node id: an exact id, else a
 * case-insensitive exact name, else a unique name substring.
 * @returns the id, or undefined when neither was given.
 */
function resolveNodeId(nodes, args) {
  if (typeof args?.id === 'string' && args.id.trim() !== '') return args.id.trim()
  if (typeof args?.name !== 'string' || args.name.trim() === '') return undefined
  const query = args.name.trim().toLowerCase()
  const exact = nodes.filter((node) => node.name.toLowerCase() === query)
  const matches = exact.length > 0 ? exact : nodes.filter((node) => node.name.toLowerCase().includes(query))
  if (matches.length === 1) return matches[0].id
  if (matches.length === 0) throw new Error(`no node named "${args.name}"`)
  throw new Error(`"${args.name}" matches ${matches.length} nodes (${matches.map((node) => `${node.name} [${node.id}]`).join(', ')}); pass an id`)
}

/** Resolve a node that the action requires. */
function requireNodeId(nodes, args) {
  const id = resolveNodeId(nodes, args)
  if (id === undefined) throw new Error('pass the node `id` or `name`')
  return id
}

/**
 * Register the Host half.
 * @param ctx - plugin context.
 * @param config - plugin row config used as first-run defaults.
 */
export function apply(ctx, config = {}) {
  markMounted(ctx, 'proxy')
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
          'Control the Shadowsocks egress proxy, which holds a list of nodes with one active. `enable` routes this process outbound HTTP (web fetch/search, MCP, LLM) and child-process HTTP through the active node, and newly launched browser sessions use it too; `disable` restores direct access. `list` shows the nodes (no passwords), `import` adds every node in `uri` (ss:// links, a base64 subscription, Clash YAML, or JSON), `select` switches the active node and `remove` deletes one (both by `id` or `name`), `configure` edits a node (`id`/`name`, default the active one) or the global local port/bypass, `test` probes a node (default the active one) with one real request, `test_all` probes every node, `status` reports the current route; `reset` forgets all nodes and passwords. Passwords are stored in the local state file (mode 0600), so an enabled route comes back by itself after a Host restart.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'list', 'enable', 'disable', 'configure', 'test', 'test_all', 'import', 'select', 'remove', 'reset'],
              description: 'Operation to perform.',
            },
            id: { type: 'string', description: 'Node id (from `list`), for `select`, `remove`, `configure`, `test`.' },
            name: { type: 'string', description: 'Node name instead of `id`: case-insensitive exact match, else a unique substring. For `configure`, this selects the node; it is not a rename.' },
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
              description: 'Nodes to add, for `import`: ss:// links (one per line), a base64 subscription, a Clash YAML `proxies:` list, or Shadowsocks JSON.',
            },
            target: { type: 'string', description: 'host:port probe target for `test` / `test_all` (default www.gstatic.com:80).' },
          },
          required: ['action'],
        },
        output: {
          schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, state: { type: 'object' } } },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        timeoutMs: 120000,
        isConcurrencySafe: () => false,
        execute: async (args) => {
          const action = String(args?.action ?? '')
          try {
            const nodes = controller.state().nodes
            if (action === 'status') return { ok: true, state: controller.state() }
            if (action === 'list') return { ok: true, activeId: controller.state().activeId, nodes }
            if (action === 'enable') return { ok: true, state: await controller.enable() }
            if (action === 'disable') return { ok: true, state: await controller.disable() }
            if (action === 'configure') {
              return {
                ok: true,
                state: await controller.configure({
                  id: resolveNodeId(nodes, args),
                  server: args.server,
                  port: args.port,
                  method: args.method,
                  password: args.password,
                  localPort: args.localPort,
                  bypass: args.bypass,
                }),
              }
            }
            if (action === 'import') return { ok: true, ...(await controller.importNodes(String(args.uri ?? ''))) }
            if (action === 'select') return { ok: true, state: await controller.select(requireNodeId(nodes, args)) }
            if (action === 'remove') return { ok: true, state: await controller.removeNode(requireNodeId(nodes, args)) }
            if (action === 'reset') return { ok: true, state: await controller.reset() }
            if (action === 'test') {
              const result = await controller.test(args.target, resolveNodeId(nodes, args))
              return { ok: true, test: result, state: controller.state() }
            }
            if (action === 'test_all') return { ok: true, state: await controller.testAll(args.target) }
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
        handler: guardRoute(ctx, async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')
          
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
            const test = await controller.test(body.target, body.id)
            sendJson(res, 200, { ok: true, test, state: controller.state() })
            return
          }
          if (action === 'test-all') {
            sendJson(res, 200, { ok: true, state: await controller.testAll(body.target) })
            return
          }
          if (action === 'import') {
            const result = await controller.importNodes(String(body.text ?? body.uri ?? ''))
            sendJson(res, 200, { ok: true, ...result })
            return
          }
          if (action === 'select') {
            sendJson(res, 200, { ok: true, state: await controller.select(body.id) })
            return
          }
          if (action === 'remove') {
            sendJson(res, 200, { ok: true, state: await controller.removeNode(body.id) })
            return
          }
          if (action === 'reset') {
            sendJson(res, 200, { ok: true, state: await controller.reset() })
            return
          }
          sendJson(res, 404, { ok: false, error: `unknown action "${action}"` })

        }),
      }),
    `ss-proxy: POST ${API_PATH}/*`,
  )
}
