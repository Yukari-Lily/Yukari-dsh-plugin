/**
 * Static site publishing for the Harness: copies a built site into the publish
 * directory served at `/p/`, keeps one manifest per site, and regenerates the index
 * page. The Host half also answers the panel's small JSON API and registers the
 * `publish_site` / `delete_site` / `list_sites` tools.
 * @module @local/publish-sites
 */
import { markMounted } from '../shared/mounted.js'
import { SiteStore } from './lib/sites.js'
import { guardRoute, readJsonBody, sendJson } from '../shared/http.js'

/** JSON API prefix the Web panel calls. */
export const API_PATH = '/publish/api'

/** Services this plugin needs. */
export const inject = ['tools', 'webServer', 'connection']

/** User agent the deployment's edge accepts; a bare curl UA is rejected with 403. */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'

/** Best-effort reachability probe of the published URL; never throws. */
async function probe(url) {
  if (!/^https?:\/\//i.test(url)) return null
  // Never fetch loopback, link-local or panel-origin addresses: the prefix is
  // panel-writable, so an unchecked probe is a request the operator did not ask
  // for, sent from the Host with its network position.
  if (publicBaseRejection(url, '') !== null) return null
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
      'Publish one built static site: copy the directory into the publish root, swap it in atomically, and return the public URL. The root is served by whatever static server the deployment points at /p; without one the URL does not answer. The source must have index.html at its top level and reference its assets with relative paths (./assets/...); absolute root paths such as /assets/x.js are rejected. Secrets and build junk (.env*, .git, node_modules, key files) are skipped.',
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
          skipped: { type: 'number', description: 'Files left out of the publish because they hold secrets or build junk.' },
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
        ...(record.skipped === undefined ? {} : { skipped: record.skipped }),
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
              required: ['slug', 'title', 'url', 'files', 'version'],
              properties: {
                slug: { type: 'string', description: 'Path segment.' },
                title: { type: 'string', description: 'Index title.' },
                url: { type: 'string', description: 'Public URL.' },
                files: { type: 'number', description: 'Number of published files.' },
                version: { type: 'number', description: 'Publish generation.' },
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
      'Unpublish one static site: move its directory out of the publish root into the local trash. The public URL stops working immediately.',
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
        handler: guardRoute(ctx, async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')
          
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
            await store.setPublicBase(body.publicBase, { panelHost: req.headers.host })
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

        }),
      }),
    `publish-sites: ${API_PATH}/*`,
  )
}
