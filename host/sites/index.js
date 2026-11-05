/**
 * Static site publishing for the Harness: copies a built site into the publish
 * directory served at `/p/`, keeps one manifest per site, and regenerates the index
 * page. The Host half also answers the panel's small JSON API and registers the
 * `publish_site` / `delete_site` / `list_sites` tools.
 * @module @local/publish-sites
 */
import { markMounted } from '../shared/mounted.js'
import { SiteStore } from './lib/sites.js'

/** JSON API prefix the Web panel calls. */
export const API_PATH = '/publish/api'

/** Largest accepted request body. */
const MAX_BODY_BYTES = 64 * 1024

/** Services this plugin needs. */
export const inject = ['tools', 'webServer', 'connection']

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

/** User agent the deployment's edge accepts; a bare curl UA is rejected with 403. */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'

/** Best-effort reachability probe of the published URL; never throws. */
async function probe(url) {
  if (!/^https?:\/\//i.test(url)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    })
    await response.body?.cancel().catch(() => {})
    return response.status
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** Human-readable byte count. */
const mb = (bytes) => `${(Number(bytes) / 1048576).toFixed(1)} MB`

/**
 * Register the Host half.
 * @param ctx - plugin context.
 * @param config - plugin row config: root, stateRoot, publicBase, maxMb, keep.
 */
export function apply(ctx, config = {}) {
  markMounted(ctx, 'sites')
  const store = new SiteStore(config)

  ctx.effect(async () => {
    await store.init()
    return () => {}
  }, 'publish-sites: init')

  ctx.tools.register({
    name: 'publish_site',
    description:
      'Publish one built static site to the web server path /p/. Copies the directory into the publish root, swaps it in atomically, refreshes the index page, and returns the public URL. The source must have index.html at its top level and reference its assets with relative paths (./assets/...); absolute root paths such as /assets/x.js are rejected because the site is served under a path prefix.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['source'],
      properties: {
        source: {
          type: 'string',
          description: 'Absolute path of the built site directory; it must contain index.html.',
        },
        slug: {
          type: 'string',
          description: 'URL path segment (lowercase a-z, 0-9, dot, dash, underscore). Defaults to the directory name.',
        },
        title: {
          type: 'string',
          description: 'Title shown in the artifact index. Defaults to the page <title>.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'slug'],
        properties: {
          url: { type: 'string', description: 'Public URL of the published site.' },
          slug: { type: 'string', description: 'Path segment the site occupies.' },
          title: { type: 'string', description: 'Title recorded in the artifact index.' },
          files: { type: 'number', description: 'Number of files published.' },
          bytes: { type: 'number', description: 'Total size in bytes.' },
          version: { type: 'number', description: 'Publish generation of this slug.' },
          status: { type: 'number', description: 'HTTP status the public URL answered during the post-publish probe; absent when the probe could not run.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `published ${value.url} (${value.files} files, ${mb(value.bytes)}, v${value.version ?? 1})${value.status === undefined ? '' : ` · HTTP ${value.status}`}`,
        },
      ],
    },
    async execute(args) {
      const record = await store.publish({
        source: String(args.source ?? ''),
        slug: typeof args.slug === 'string' ? args.slug : undefined,
        title: typeof args.title === 'string' ? args.title : undefined,
      })
      const status = await probe(record.url)
      return {
        url: record.url,
        slug: record.slug,
        title: record.title,
        files: record.files,
        bytes: record.bytes,
        version: record.version,
        ...(status === null ? {} : { status }),
      }
    },
  })

  ctx.tools.register({
    name: 'list_sites',
    description: 'List the static sites currently published on the artifact host, newest first.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sites'],
        properties: {
          sites: {
            type: 'array',
            description: 'Published sites, newest first.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['slug', 'title', 'url'],
              properties: {
                slug: { type: 'string', description: 'Path segment.' },
                title: { type: 'string', description: 'Index title.' },
                url: { type: 'string', description: 'Public URL.' },
                bytes: { type: 'number', description: 'Total size in bytes.' },
                publishedAt: { type: 'string', description: 'ISO time of the last publish.' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.sites.length === 0
              ? 'no published sites'
              : value.sites.map((site) => `${site.slug}\t${site.url}\t${mb(site.bytes)}`).join('\n'),
        },
      ],
    },
    async execute() {
      return { sites: await store.list() }
    },
  })

  ctx.tools.register({
    name: 'delete_site',
    description:
      'Unpublish one static site: moves its directory out of the publish root into the local trash and refreshes the index page. The public URL stops working immediately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: {
        slug: { type: 'string', description: 'Path segment of the site to unpublish.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['slug', 'deleted'],
        properties: {
          slug: { type: 'string', description: 'Path segment that was removed.' },
          deleted: { type: 'boolean', description: 'True when a site was removed.' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.deleted ? `unpublished /${value.slug}/` : `no site at /${value.slug}/` },
      ],
    },
    async execute(args) {
      return await store.remove(String(args.slug ?? ''))
    },
  })

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
            if (action === 'list') {
              if (req.method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'use GET' })
                return
              }
              sendJson(res, 200, {
                ok: true,
                sites: await store.list(),
                root: store.root,
                publicBase: store.publicBase,
                defaultPublicBase: store.defaultPublicBase,
                customPublicBase: store.customPublicBase !== null,
              })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'use POST' })
              return
            }
            const body = await readJsonBody(req)
            if (action === 'settings') {
              await store.setPublicBase(body.publicBase)
              sendJson(res, 200, {
                ok: true,
                sites: await store.list(),
                root: store.root,
                publicBase: store.publicBase,
                defaultPublicBase: store.defaultPublicBase,
                customPublicBase: store.customPublicBase !== null,
              })
              return
            }
            if (action === 'delete') {
              const result = await store.remove(String(body.slug ?? ''))
              sendJson(res, 200, { ok: true, ...result, sites: await store.list() })
              return
            }
            sendJson(res, 404, { ok: false, error: `unknown action "${action}"` })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: messageOf(error) })
          }
        },
      }),
    `publish-sites: ${API_PATH}/*`,
  )
}
