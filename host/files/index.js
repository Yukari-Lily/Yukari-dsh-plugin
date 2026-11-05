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
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { markMounted } from '../shared/mounted.js'
import { writeZip } from './lib/zip-writer.js'
import { guardRoute, readJsonBody, sendJson } from '../shared/http.js'

/** JSON API prefix served to the panel. */
export const API_PATH = '/files/api'

/** Services this component needs. */
export const inject = ['tools', 'webServer', 'connection']

/** Entries one directory listing returns. */
const MAX_ENTRIES = 5000

/** How long a resolved root list stays fresh. */
const ROOTS_TTL_MS = 30_000

/** Files one archive request may contain. */
const MAX_ARCHIVE_FILES = 5000

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

/** Directory listing of one workspace folder. */
async function listDirectory(root, relative, fs) {
  const directory = await resolveInside(root, relative, fs)
  const info = await fs.stat(directory)
  if (!info.isDirectory()) throw new Error(`不是目录：${relative}`)
  const entries = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entries.length >= MAX_ENTRIES) break
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
  return entries
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
    if (files.length >= MAX_ARCHIVE_FILES) throw new Error(`所选文件超过 ${MAX_ARCHIVE_FILES} 个`)
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
    if (clean === '') throw new Error('请选择具体文件或文件夹，不能是整个工作区')
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
    const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry
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

  /**
   * The newest chat whose workspace is this root. Preview addresses are
   * session-scoped, so it is only asked for when a preview is requested — not
   * on every directory listing.
   * @param rootId - resolved workspace root.
   * @returns the session id, or null when the workspace has no chat.
   */
  async function anchorOf(rootId) {
    const query = ctx.get?.('sessionQuery') ?? ctx.sessionQuery
    let records = []
    try {
      records = (await query?.listSessions?.()) ?? []
    } catch {
      return null
    }
    const newest = records
      .filter((record) => record.header?.cwd === rootId)
      .sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0))[0]
    return newest?.header?.id ?? null
  }

  /** Resolve the `root` query value against the allowed roots. */
  async function rootOf(value) {
    const allowed = await roots()
    const found = allowed.find((root) => root.id === value)
    if (found === undefined) throw new Error('未知的工作区')
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
          if (action === 'anchor' && req.method === 'GET') {
            const root = await rootOf(url.searchParams.get('root') ?? '')
            sendJson(res, 200, { ok: true, sessionId: await anchorOf(root.id) })
            return
          }
          if (action === 'list' && req.method === 'GET') {
            const root = await rootOf(url.searchParams.get('root') ?? '')
            const relative = safeRelative(url.searchParams.get('path') ?? '')
            sendJson(res, 200, { ok: true, path: relative, entries: await listDirectory(root.id, relative, fs) })
            return
          }
          if (action === 'download' && req.method === 'GET') {
            const root = await rootOf(url.searchParams.get('root') ?? '')
            const relative = safeRelative(url.searchParams.get('path') ?? '')
            const file = await resolveInside(root.id, relative, fs)
            const info = await stat(file)
            if (!info.isFile()) throw new Error('只能下载普通文件')
            res.statusCode = 200
            res.setHeader('content-type', 'application/octet-stream')
            res.setHeader('content-length', String(info.size))
            res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`)
            const stream = createReadStream(file)
            stream.on('error', () => {
              if (!res.writableEnded) res.destroy()
            })
            await new Promise((resolve) => {
              stream.on('end', resolve)
              stream.on('close', resolve)
              stream.pipe(res)
            })
            return
          }
          if (action === 'archive' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const root = await rootOf(typeof body.root === 'string' ? body.root : '')
            const requested = Array.isArray(body.paths) ? body.paths.filter((item) => typeof item === 'string') : []
            if (requested.length === 0) throw new Error('请至少选择一个文件或文件夹')
            const { files, skipped } = await collectFiles(root.id, requested, fs)
            if (files.length === 0) throw new Error('没有可打包的内容：所选项目都是符号链接')
            const name = `${path.basename(root.path) || 'workspace'}-${new Date().toISOString().slice(0, 10)}.zip`
            res.statusCode = 200
            res.setHeader('content-type', 'application/zip')
            res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(name)}"`)
            const result = await writeZip(res, files, {
              maxTotalBytes: (Number(config.maxMb) > 0 ? Number(config.maxMb) : 1024) * 1048576,
            })
            res.end()
            if (skipped.length > 0) ctx.logger?.warn?.(`yukari-files: skipped ${skipped.length} symbolic links`)
            void result
            return
          }
          sendJson(res, 404, { ok: false, error: `未知的文件操作「${action}」` })

        }),
      }),
    `yukari-files: ${API_PATH}/*`,
  )
}
