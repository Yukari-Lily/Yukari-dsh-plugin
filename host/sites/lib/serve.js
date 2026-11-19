/**
 * Static responses for the publish root.
 *
 * 宿主自己把 `<路径>/<slug>/` 答出来：默认本地部署（127.0.0.1、Windows 客户端）
 * 没有别的静态服务器，少了这一段，发布出来的链接就是 404。这里只读发布根，状态
 * 目录、隐藏文件与打包垃圾都不能通过它离开磁盘。
 * @module @local/publish-sites/lib/serve
 */
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { streamToResponse } from '../../shared/http.js'

/** 站点目录名规则，与 store 发布时用的那份一致。 */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,40}$/

/** 任何情况下都不对外提供的名字（发布时已过滤，这里防手工放进来的）。 */
const NEVER_PUBLISH = /(^|\/)(\.git|\.env[^/]*|node_modules)(\/|$)|(^|\/)[^/]+\.(pem|key|p12|pfx)$/

/** 只按后缀给出常见的 Web 类型，其余按二进制流。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
}

/** 空响应；状态码自己说明问题。 */
function send(res, status, headers = {}) {
  res.statusCode = status
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end()
}

/** 一个路径段里不该出现的字符：分隔符、NUL、Windows 盘符与数据流语法。 */
function badSegment(segment) {
  return segment === '' || segment === '.' || segment === '..'
    || segment.includes('/') || segment.includes('\\')
    || segment.includes('\0') || segment.includes(':')
}

/**
 * 把一次挂在 `prefix` 下的请求映射为发布根里的文件。
 * @param store - SiteStore；只用它的 `root`，第一次请求时完成 `init()`。
 * @param prefix - 挂载路径，由注册这条路由的人给出（面板可以改）。
 * @returns `(req, res) => Promise<void>`。
 */
export function siteHandler(store, prefix) {
  return async (req, res) => {
    await store.init()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { allow: 'GET, HEAD' })
      return
    }
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      send(res, 404)
      return
    }
    const rest = url.pathname.slice(prefix.length)
    if (rest === '' || rest === '/') {
      send(res, 404)
      return
    }

    const segments = rest.split('/').slice(1)
    const trailing = segments.length > 0 && segments[segments.length - 1] === ''
    if (trailing) segments.pop()
    if (segments.length === 0) {
      send(res, 404)
      return
    }

    const parts = []
    for (const raw of segments) {
      let segment
      try {
        segment = decodeURIComponent(raw)
      } catch {
        send(res, 400)
        return
      }
      // 点开头的一律不对外：默认状态目录 `.publish-state` 就在这条规则里被挡住。
      if (badSegment(segment) || segment.startsWith('.')) {
        send(res, 404)
        return
      }
      parts.push(segment)
    }
    if (!SLUG.test(parts[0])) {
      send(res, 404)
      return
    }
    const relative = parts.join('/')
    if (NEVER_PUBLISH.test(relative)) {
      send(res, 404)
      return
    }

    const target = path.resolve(store.root, ...parts)
    const back = path.relative(store.root, target)
    if (back === '' || back.startsWith('..') || path.isAbsolute(back)) {
      send(res, 404)
      return
    }

    const realRoot = await realpath(store.root).catch(() => null)
    if (realRoot === null) {
      send(res, 404)
      return
    }
    let file = target
    let info = await stat(file).catch(() => null)
    if (info === null) {
      send(res, 404)
      return
    }
    if (info.isDirectory()) {
      // 不带尾斜杠时先把浏览器带回目录 URL，否则页面里的相对资源会挂到挂载路径下。
      if (!trailing) {
        send(res, 301, { location: `${url.pathname}/` })
        return
      }
      file = path.join(target, 'index.html')
      info = await stat(file).catch(() => null)
      if (info === null || !info.isFile()) {
        send(res, 404)
        return
      }
    } else if (!info.isFile()) {
      send(res, 404)
      return
    }

    // 手工放进去的符号链接不能把读取带出发布根。
    const realFile = await realpath(file).catch(() => null)
    if (realFile === null) {
      send(res, 404)
      return
    }
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) {
      send(res, 403)
      return
    }

    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    res.statusCode = 200
    res.setHeader('content-type', type)
    res.setHeader('content-length', String(info.size))
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('x-content-type-options', 'nosniff')
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    await streamToResponse(createReadStream(file), res)
  }
}
