/**
 * Host half of the workspace file browser.
 *
 * Listing, single-file download and a ZIP of any chosen folders. Every path is
 * resolved inside one of the registered workspace roots: a request may not name
 * an absolute path, climb out with `..`, or reach a symbolic link that points
 * outside the root.
 * @module yukari-dsh-plugin/files
 */
import { createReadStream } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { markMounted } from '../shared/mounted.js'
import { writeZip } from '../shared/zip-writer.js'
import { appError, attachmentHeader, guardRoute, readJsonBody, sendJson, streamToResponse } from '../shared/http.js'

/** JSON API prefix served to the panel. */
export const API_PATH = '/files/api'

/** Services this component needs. */
export const inject = ['tools', 'webServer', 'connection']

/** Entries one directory listing returns. */
const MAX_ENTRIES = 5000

/** How long a resolved root list stays fresh. */
const ROOTS_TTL_MS = 30_000

/**
 * Files one archive request may contain.
 *
 * The archive is streamed, so file size is never a memory problem; the count is:
 * every entry keeps its name and headers until the central directory is written,
 * so a selection of millions of files would cost more RAM than the answer is
 * worth. 20 万条大约 20 MB 头部，远高于任何正常目录，又能挡住误选整盘。
 */
const MAX_ARCHIVE_FILES = 200_000

/** 面板内预览最多读这么多字节；更大的文件只显示开头并标注截断。 */
const MAX_PREVIEW_BYTES = 512 * 1024

/** 不带 zip64 的 ZIP 单包上限是 UInt32 字节；MB 配置再大也只会溢出。 */
const MAX_ARCHIVE_MB = 4096

/**
 * 图片扩展名 → MIME，图片直接交给浏览器解码，不用面板搬运字节。
 *
 * SVG 不在其中：同源内联的 SVG 是一份能执行脚本的文档，直接导航到下载地址
 * 就能用面板的 cookie 调 `/files/api`，所以它只按二进制返回、预览按文本读。
 */
const INLINE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

/**
 * 一个文件的预览内容：图片只报类型，文本带上开头若干字节。
 *
 * 文本还是二进制不靠扩展名猜：UTF-8 文本里不会出现 NUL 字节，读到的
 * 前 512KB 里只要有一个就按二进制处理，避免把 PDF、Office 文档塞进代码块。
 * @param root - 工作区根目录。
 * @param relative - 相对路径。
 * @returns `{ kind: 'text' | 'image' | 'binary', size, text?, truncated?, mime? }`。
 */
async function previewOf(root, relative) {
  const file = await resolveInside(root, relative)
  const info = await stat(file)
  if (!info.isFile()) throw new Error('只能预览普通文件')
  const extension = path.extname(file).slice(1).toLowerCase()
  const image = INLINE_MIME[extension]
  if (image !== undefined) return { kind: 'image', size: info.size, mime: image }
  const handle = await open(file, 'r')
  try {
    const length = Math.min(info.size, MAX_PREVIEW_BYTES)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const chunk = buffer.subarray(0, bytesRead)
    if (chunk.includes(0)) return { kind: 'binary', size: info.size }
    return {
      kind: 'text',
      size: info.size,
      text: chunk.toString('utf8'),
      truncated: info.size > bytesRead,
    }
  } finally {
    await handle.close()
  }
}

/** Turn any thrown value into a message. */
/**
 * Reject a relative path that could leave its root.
 * @param relative - user-supplied relative path.
 * @returns the normalized relative path, `''` for the root itself.
 */
export function safeRelative(relative) {
  const text = String(relative ?? '').replace(/\\/g, '/').trim()
  if (text === '' || text === '.') return ''
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) throw new Error('路径必须相对于工作区根目录')
  const segments = text.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.some((segment) => segment === '..')) throw new Error('路径不能超出工作区根目录')
  return segments.join('/')
}

/**
 * Resolve one path inside a root, refusing anything that escapes it through
 * `..` or a symbolic link.
 * @param root - absolute workspace root.
 * @param relative - relative path.
 * @param fs - filesystem seams, for tests.
 * @returns the absolute, real path.
 */
export async function resolveInside(root, relative, fs = { realpath, lstat, stat }) {
  const clean = safeRelative(relative)
  const absolute = path.join(root, clean)
  let real
  try {
    real = await fs.realpath(absolute)
  } catch {
    throw new Error(`路径不存在：${clean === '' ? '.' : clean}`)
  }
  const realRoot = await fs.realpath(root)
  const inside = real === realRoot || real.startsWith(`${realRoot}${path.sep}`)
  if (!inside) throw new Error(`符号链接指向工作区外：${clean}`)
  return real
}

/**
 * 单次归档允许的字节数。
 *
 * 配置再大也只按 UInt32 钳住：ZIP 的非 zip64 字段存不下 4 GiB 以上，放行只会
 * 写出溢出的大小字段。
 * @param config - component config, `maxMb` is the requested ceiling in MB.
 * @returns the byte ceiling.
 */
export function archiveLimitBytes(config = {}) {
  const requested = Number(config?.maxMb)
  const megabytes = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_ARCHIVE_MB) : MAX_ARCHIVE_MB
  return megabytes * 1048576
}

/** 强校验用的实体标记：大小或 mtime 变一个就算不同文件。 */
function etagOf(info) {
  return `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
}

/**
 * 解析单段 `Range`。
 *
 * 多段范围要 multipart 响应，这里只服务单个文件下载，按规范可以忽略并回整包；
 * 语法合法但越界才回 416，让客户端知道文件没有那么大。
 * @param header - the `range` request header.
 * @param size - file size in bytes.
 * @returns `null`（整包）、`'invalid'`（416）或 `{ start, end }`。
 */
function parseRange(header, size) {
  if (typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    if (size === 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}

/** Directory listing of one workspace folder. */
async function listDirectory(root, relative, fs) {
  const directory = await resolveInside(root, relative, fs)
  const info = await fs.stat(directory)
  if (!info.isDirectory()) throw new Error(`不是目录：${relative}`)
  const entries = []
  let truncated = false
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // 一次读目录可能几万条；截断本身可以，但要如实告诉调用方，不能悄悄少给。
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const child = path.join(directory, entry.name)
    let childInfo = null
    try {
      childInfo = await fs.lstat(child)
    } catch {
      continue
    }
    const type = childInfo.isSymbolicLink() ? 'symlink' : childInfo.isDirectory() ? 'dir' : childInfo.isFile() ? 'file' : 'other'
    entries.push({
      name: entry.name,
      path: relative === '' ? entry.name : `${relative}/${entry.name}`,
      type,
      size: type === 'file' ? childInfo.size : null,
      mtime: childInfo.mtimeMs,
    })
  }
  entries.sort((left, right) => {
    const byType = (left.type === 'dir' ? 0 : 1) - (right.type === 'dir' ? 0 : 1)
    return byType !== 0 ? byType : left.name.localeCompare(right.name)
  })
  return { entries, truncated }
}

/**
 * Expand the requested paths into the files one archive carries.
 * Symbolic links are skipped: the archive must not smuggle in a file from
 * outside the workspace.
 */
async function collectFiles(root, requested, fs) {
  const files = []
  const skipped = []
  const visit = async (relative) => {
    if (files.length >= MAX_ARCHIVE_FILES) throw new Error(`所选文件超过 ${MAX_ARCHIVE_FILES} 个，请先缩小选择范围`)
    const absolute = path.join(root, relative)
    const info = await fs.lstat(absolute)
    if (info.isSymbolicLink()) {
      skipped.push(relative)
      return
    }
    if (info.isDirectory()) {
      const children = await readdir(absolute, { withFileTypes: true })
      if (children.length === 0) files.push({ name: `${relative}/`, path: absolute, directory: true })
      for (const child of children) await visit(relative === '' ? child.name : `${relative}/${child.name}`)
      return
    }
    if (info.isFile()) files.push({ name: relative, path: absolute })
  }
  for (const item of requested) {
    const clean = safeRelative(item)
    if (clean === '') throw new Error('请选择具体文件或文件夹，不能是工作区根目录')
    await resolveInside(root, clean, fs)
    await visit(clean)
  }
  return { files, skipped }
}

/** Register the host half. */
export function apply(ctx, config = {}) {
  markMounted(ctx, 'files')
  const fs = { realpath, lstat, stat }

  /** Roots change rarely; rebuilding them costs a realpath per workspace. */
  let cachedRoots = null

  /**
   * Every root this component may serve, with a short cache.
   * @returns `[{ id, title, path }]`.
   */
  async function roots() {
    if (cachedRoots !== null && Date.now() - cachedRoots.at < ROOTS_TTL_MS) return cachedRoots.value
    // `ctx.get` only: a bare property throws in a composition that does not
    // provide the service, and this row does not inject it.
    const registry = ctx.get?.('workspaceRegistry')
    const list = []
    try {
      for (const workspace of registry?.list?.() ?? []) {
        if (typeof workspace.path === 'string' && workspace.path !== '') {
          list.push({ id: workspace.path, title: workspace.title || path.basename(workspace.path), path: workspace.path })
        }
      }
    } catch { /* a composition without workspaces still browses the cwd */ }
    if (list.length === 0 || config.includeCwd === true) {
      list.push({ id: process.cwd(), title: path.basename(process.cwd()) || process.cwd(), path: process.cwd() })
    }
    const seen = new Set()
    const value = []
    for (const root of list) {
      let real
      try {
        real = await realpath(root.path)
      } catch {
        continue
      }
      if (seen.has(real)) continue
      seen.add(real)
      value.push({ id: real, title: root.title, path: real })
    }
    cachedRoots = { at: Date.now(), value }
    return value
  }

  /** Resolve the `root` query value against the allowed roots. */
  async function rootOf(value) {
    const allowed = await roots()
    const found = allowed.find((root) => root.id === value)
    if (found === undefined) throw new Error('未知工作区')
    return found
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: guardRoute(ctx, async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')
          
          if (action === 'roots' && req.method === 'GET') {
            sendJson(res, 200, { ok: true, roots: await roots() })
            return
          }
          if (action === 'list' && req.method === 'GET') {
            const root = await rootOf(url.searchParams.get('root') ?? '')
            const relative = safeRelative(url.searchParams.get('path') ?? '')
            // `entries` 保持原样供面板直接使用；`truncated` 说明这次列表被上限截断。
            const listing = await listDirectory(root.id, relative, fs)
            // `limit` 一并给出：面板要把「只显示了前 N 项」说成具体数字。
            sendJson(res, 200, { ok: true, path: relative, entries: listing.entries, truncated: listing.truncated, limit: MAX_ENTRIES })
            return
          }
          if (action === 'preview' && req.method === 'GET') {
            const root = await rootOf(url.searchParams.get('root') ?? '')
            const relative = safeRelative(url.searchParams.get('path') ?? '')
            sendJson(res, 200, { ok: true, ...(await previewOf(root.id, relative)) })
            return
          }
          if (action === 'download' && req.method === 'GET') {
            const root = await rootOf(url.searchParams.get('root') ?? '')
            const relative = safeRelative(url.searchParams.get('path') ?? '')
            const file = await resolveInside(root.id, relative, fs)
            const info = await stat(file)
            if (!info.isFile()) throw new Error('只能下载普通文件')
            // inline=1 供面板预览取图：浏览器按真实类型解码，不再强制下载。
            // SVG 例外——同源内联的 SVG 会执行脚本，按二进制返回只触发下载。
            const inline = url.searchParams.get('inline') === '1'
            const extension = path.extname(file).slice(1).toLowerCase()
            // SVG 即使要求内联也按二进制返回：同源内联的 SVG 会执行脚本。
            const type = !inline || extension === 'svg'
              ? 'application/octet-stream'
              : INLINE_MIME[extension] ?? 'text/plain; charset=utf-8'
            const range = parseRange(req.headers?.range, info.size)

            res.setHeader('x-content-type-options', 'nosniff')
            res.setHeader('accept-ranges', 'bytes')
            if (range === 'invalid') {
              res.statusCode = 416
              res.setHeader('content-range', `bytes */${info.size}`)
              res.end()
              return
            }

            res.statusCode = range === null ? 200 : 206
            res.setHeader('content-type', type)
            res.setHeader('content-length', String(range === null ? info.size : range.end - range.start + 1))
            res.setHeader('etag', etagOf(info))
            res.setHeader('last-modified', info.mtime.toUTCString())
            if (range !== null) res.setHeader('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
            if (inline) {
              // 内联只给图片用；CSP 再兜一层，万一被当成文档打开也不会执行脚本。
              res.setHeader('content-security-policy', 'sandbox')
            } else {
              res.setHeader('content-disposition', attachmentHeader(path.basename(file)))
            }
            const stream = createReadStream(file, range === null ? {} : { start: range.start, end: range.end })
            await streamToResponse(stream, res)
            return
          }
          if (action === 'archive' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const root = await rootOf(typeof body.root === 'string' ? body.root : '')
            const requested = Array.isArray(body.paths) ? body.paths.filter((item) => typeof item === 'string') : []
            if (requested.length === 0) throw appError('请至少选择一个文件或文件夹', 'files-selection-empty')
            const { files, skipped } = await collectFiles(root.id, requested, fs)
            if (files.length === 0) throw appError('没有可打包的内容：所选项目均为符号链接', 'files-archive-empty')
            const name = `${path.basename(root.path) || 'workspace'}-${new Date().toISOString().slice(0, 10)}.zip`
            res.statusCode = 200
            res.setHeader('content-type', 'application/zip')
            res.setHeader('content-disposition', attachmentHeader(name))
            try {
              await writeZip(res, files, { maxTotalBytes: archiveLimitBytes(config) })
            } catch (error) {
              // 预检失败时一个字节都没写：撤掉附件头，让错误信封干净地回给面板。
              if (!res.headersSent) {
                res.removeHeader('content-type')
                res.removeHeader('content-disposition')
              }
              throw error
            }
            res.end()
            if (skipped.length > 0) ctx.logger?.warn?.(`yukari-files: skipped ${skipped.length} symbolic links`)
            return
          }
          sendJson(res, 404, { ok: false, error: `未知的文件操作「${action}」` })

        }),
      }),
    `yukari-files: ${API_PATH}/*`,
  )
}
