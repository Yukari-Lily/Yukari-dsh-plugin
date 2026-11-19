/**
 * Static site publishing for the Harness: copies a built site into the publish
 * directory served under the configured path, keeps one manifest per site, and
 * regenerates the index page. The Host half also answers the panel's small JSON
 * API and registers the `publish_site` / `delete_site` / `list_sites` tools.
 * @module @local/publish-sites
 */
import { markMounted } from '../shared/mounted.js'
import { DEFAULT_SITE_PATH, SiteStore, formatBytes } from './lib/sites.js'
import { siteHandler } from './lib/serve.js'
import { appError, guardRoute, messageOf, readJsonBody, sendJson } from '../shared/http.js'

export { DEFAULT_SITE_PATH }

/** JSON API prefix the Web panel calls. */
export const API_PATH = '/publish/api'

/** Services this plugin needs. */
export const inject = ['tools', 'webServer', 'connection']

/**
 * Register the Host half.
 * @param ctx - plugin context.
 * @param config - plugin row config: root, stateRoot, path, maxMb, keep.
 */
export function apply(ctx, config = {}) {
  markMounted(ctx, 'sites')
  const store = new SiteStore(config)
  if (store.rowPathRejection !== null) {
    ctx.logger?.warn?.(`yukari-sites: 行配置里的路径不可用（${store.rowPathRejection.reason}），按 ${DEFAULT_SITE_PATH} 提供`)
  }

  /**
   * Origin a local browser reaches this Host at.
   *
   * 面板页面自己不一定有 http(s) 来源：Windows 客户端用 `dsh-app://app` 加载，
   * 再用 IPC 桥接请求。那种情况下站点链接只能靠宿主回报的监听地址，端口读的是
   * 实际绑定值（`port: 0` 时由系统分配）。
   * @returns the origin, e.g. `http://127.0.0.1:3080`, or null when unbound.
   */
  const localBase = () => {
    try {
      if (typeof ctx.webServer.getOrigin === 'function') return ctx.webServer.getOrigin()
    } catch {
      // 监听器尚未绑定：面板退回相对路径。
    }
    const host = String(ctx.webServer.host ?? '')
    const port = Number(ctx.webServer.port)
    if (host === '' || !Number.isInteger(port)) return null
    const authority = host.includes(':') ? `[${host}]` : host
    return `${ctx.webServer.protocol ?? 'http:'}//${authority}:${port}`
  }

  /** Disposer of the route currently answering the publish root. */
  let releaseRoute = null
  /** Path that live route is registered at. */
  let mountedPath = null

  /** Register the publish root at one path. */
  const mountSite = (sitePath) => {
    const release = ctx.webServer.register({ kind: 'prefix', path: sitePath, handler: siteHandler(store, sitePath) })
    releaseRoute = release
    mountedPath = sitePath
  }

  /**
   * Move the publish root to another path, keeping the old one when the new one
   * is taken. 同名路由在宿主里是硬冲突，先摘后挂才可能换成同一路径。
   */
  const swapSitePath = (sitePath) => {
    const previous = mountedPath
    releaseRoute?.()
    releaseRoute = null
    mountedPath = null
    try {
      mountSite(sitePath)
    } catch (error) {
      if (previous !== null) {
        try {
          mountSite(previous)
        } catch (restoreError) {
          ctx.logger?.warn?.(`publish-sites: 恢复路径 ${previous} 失败：${messageOf(restoreError)}`)
        }
      }
      throw appError(`站点路径 ${sitePath} 已被其它功能占用`, 'path-taken')
    }
  }

  // 发布根由宿主自己应答：默认本地部署没有别的静态服务器，少了这条，站点链接就是 404。
  // 站点是公开产物，所以这条路由不经过 connection 的浏览器鉴权。
  ctx.effect(async () => {
    await store.init()
    try {
      mountSite(store.sitePath)
    } catch (error) {
      // 保存的路径在启动时被占用：整个组件不能因此装不上，否则连面板里改回来的
      // 入口都没有。退回默认路径，把原本想要的路径留给面板说明。
      const wanted = store.sitePath
      ctx.logger?.warn?.(`publish-sites: 路径 ${wanted} 无法挂载（${messageOf(error)}），回退 ${DEFAULT_SITE_PATH}`)
      if (wanted !== DEFAULT_SITE_PATH) store.pathFallback = { path: wanted }
      store.customSitePath = null
      store.defaultSitePath = DEFAULT_SITE_PATH
      try {
        mountSite(DEFAULT_SITE_PATH)
      } catch (fallbackError) {
        ctx.logger?.warn?.(`publish-sites: 默认路径也无法挂载：${messageOf(fallbackError)}`)
      }
    }
    return () => {
      releaseRoute?.()
      releaseRoute = null
      mountedPath = null
    }
  }, 'publish-sites: publish root')

  ctx.tools.register({
    name: 'publish_site',
    description:
      'Publish one built static site: copy the directory into the publish root, swap it in atomically, and return its URL. The URL is relative to the Host (the panel resolves it against the address it is reached at); the result also carries verifyUrl, the same path on the Host\'s own listen origin — use it to check the upload with a plain request, since a reverse proxy or deployment authentication in front of the public address is not part of this component. Files are served from the publish root that list_sites reports. The source must have index.html at its top level and reference its assets with relative paths (./assets/...); absolute root paths such as /assets/x.js are rejected. Secrets and build junk (.env*, .git, node_modules, key files) are skipped.',
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
          verifyUrl: { type: 'string', description: 'Address the Host itself answers on: its listen origin plus the site path. Use it to check the copy without going through a reverse proxy; absent when the listener is not bound yet.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `published ${value.url} (${value.files} files, ${formatBytes(value.bytes)}, v${value.version ?? 1})${value.verifyUrl === undefined ? '' : ` · verify ${value.verifyUrl}`}`,
        },
      ],
    },
    async execute(args) {
      const record = await store.publish({
        source: String(args.source ?? ''),
        slug: typeof args.slug === 'string' ? args.slug : undefined,
        title: typeof args.title === 'string' ? args.title : undefined,
      })
      const origin = localBase()
      return {
        url: record.url,
        ...(origin === null ? {} : { verifyUrl: `${origin}${record.url}` }),
        slug: record.slug,
        title: record.title,
        files: record.files,
        bytes: record.bytes,
        ...(record.skipped === undefined ? {} : { skipped: record.skipped }),
        version: record.version,
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
        required: ['sites', 'root'],
        properties: {
          root: { type: 'string', description: 'Absolute path of the publish root these sites are served from.' },
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
              ? `no published sites in ${value.root}`
              : [`root: ${value.root}`, ...value.sites.map((site) => `${site.slug}\t${site.url}\t${formatBytes(site.bytes)}`)].join('\n'),
        },
      ],
    },
    async execute() {
      return { sites: await store.list(), root: store.root }
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
        {
          type: 'text',
          text: value.deleted
            ? `unpublished ${store.sitePath}/${value.slug}/`
            : `no site at ${store.sitePath}/${value.slug}/`,
        },
      ],
    },
    async execute(args) {
      return await store.remove(String(args.slug ?? ''))
    },
  })

  /**
   * Everything the panel knows about the publish root, in one shape.
   *
   * 列表里的 URL 每次都按当前路径重算：换路径后已发布的站点不需要重新发布。
   */
  const describe = async () => ({
    ok: true,
    sites: await store.list(),
    root: store.root,
    localBase: localBase(),
    adoptedFrom: store.adoptedFrom,
    sitePath: store.sitePath,
    defaultPath: store.defaultSitePath,
    customSitePath: store.customSitePath !== null,
    pathFallback: store.pathFallback,
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
            sendJson(res, 200, await describe())
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'use POST' })
            return
          }
          const body = await readJsonBody(req)
          if (action === 'settings') {
            // 换路径要同时动路由和配置：失败时两边都保持原样，面板看到的就是现状。
            await store.setSitePath(body.path, swapSitePath)
            sendJson(res, 200, await describe())
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
