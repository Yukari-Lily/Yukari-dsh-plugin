/**
 * Filesystem side of static-site publishing.
 *
 * The publish root is the directory the web server exposes at `/p/`, so
 * everything inside it is public. Manifests, staging and trash therefore live
 * outside the root, under the state directory, and never reach the Web.
 * @module @local/publish-sites/lib/sites
 */
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** Allowed URL segment. */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,40}$/

/** Bound recursive copies as well as total bytes. */
const DEFAULT_MAX_FILES = 10000

/** An asset reference that resolves against the origin root instead of the site. */
const ROOT_LINK = /(?:src|href)\s*=\s*["']\/[^/"']/i

/** Skip absurdly large HTML files when scanning for root links. */
const MAX_HTML_SCAN_BYTES = 4 * 1024 * 1024

/** Read one positive number from config. */
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback
}

/** Human-readable byte count. */
function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1048576).toFixed(1)} MB`
}

/** Recursive walk yielding regular files and rejecting every symbolic link. */
async function* walk(directory, sourceRoot = directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`不允许符号链接：${path.relative(sourceRoot, file) || file}`)
    }
    if (entry.isDirectory()) {
      yield* walk(file, sourceRoot)
    } else if (entry.isFile()) {
      yield { file, size: (await stat(file)).size }
    }
  }
}

/** First path in `directory` derived from `base` that does not exist yet. */
async function uniquePath(directory, base) {
  let candidate = path.join(directory, base)
  let counter = 2
  for (;;) {
    try {
      await lstat(candidate)
      candidate = path.join(directory, `${base}-${counter}`)
      counter += 1
    } catch {
      return candidate
    }
  }
}

/** A local timestamp usable in a directory name, unique within one run. */
function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Validate one public URL prefix. A bare host gets `https://`; a trailing
 * slash, query or fragment is dropped.
 * @param value - user input.
 * @returns the normalized prefix without a trailing slash.
 */
export function normalizePublicBase(value) {
  let text = String(value ?? '').trim()
  if (text === '') throw new Error('访问前缀不能为空')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`不是有效的网址：${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('访问前缀只支持 http:// 或 https://')
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/**
 * Why a host cannot carry published pages, or null when it can.
 *
 * Loopback, unspecified and link-local addresses point back at this machine —
 * either at the panel itself or at the cloud metadata endpoint — so a prefix
 * naming one of them turns every publish probe into a request from the Host.
 * Private RFC1918 ranges stay allowed: publishing to the LAN is a real use.
 * @param hostname - parsed hostname, IPv6 brackets included or not.
 */
function forbiddenHostReason(hostname) {
  const host = String(hostname).trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return '本机回环地址'
  const version = isIP(host)
  if (version === 4) {
    const octets = host.split('.').map(Number)
    if (octets[0] === 127 || octets[0] === 0) return '本机回环地址'
    if (octets[0] === 169 && octets[1] === 254) return '链路本地地址'
  }
  if (version === 6) {
    if (host === '::1' || host === '::') return '本机回环地址'
    if (/^fe[89ab]/.test(host)) return '链路本地地址'
    if (/^f[cd]/.test(host)) return '唯一本地地址'
  }
  return null
}

/**
 * Why a prefix cannot be used, or null when it can.
 * @param value - prefix text from the panel or the row config.
 * @param panelHost - `Host` header of the panel request; a prefix on it would
 *   share the panel's origin and therefore its session.
 */
export function publicBaseRejection(value, panelHost = '') {
  const text = String(value ?? '').trim()
  if (text === '') return null
  let url
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return '不是合法的网址'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只支持 http 与 https'
  const forbidden = forbiddenHostReason(url.hostname)
  if (forbidden !== null) return forbidden
  const panel = String(panelHost ?? '').trim().toLowerCase()
  if (panel !== '' && url.host.toLowerCase() === panel) {
    return '与面板同源，页面里的脚本会带着面板的登录态访问接口'
  }
  return null
}

/** Names that must never be served from the publish root. */
const NEVER_PUBLISH = /(^|\/)(\.git|\.env[^/]*|node_modules)(\/|$)|(^|\/)[^/]+\.(pem|key|p12|pfx)$/

export class SiteStore {
  /**
   * @param config - root, stateRoot, publicBase, maxMb, keep.
   */
  constructor(config = {}) {
    const root = path.resolve(String(config.root ?? path.join(os.homedir(), 'publish')))
    this.root = root
    this.stateRoot = path.resolve(String(config.stateRoot ?? path.join(path.dirname(root), '.publish-state')))
    this.defaultPublicBase = typeof config.publicBase === 'string' && config.publicBase.trim() !== ''
      ? config.publicBase.trim().replace(/\/+$/, '')
      : 'http://127.0.0.1:3080/p'
    /** Prefix saved from the panel; overrides the row config when set. */
    this.customPublicBase = null
    this.maxMb = positive(config.maxMb, 200)
    this.maxFiles = positive(config.maxFiles, DEFAULT_MAX_FILES)
    this.keep = positive(config.keep, 5)
    this.ready = null
    /** Mutations run one at a time: staging, trash and manifests are shared. */
    this.queue = Promise.resolve()
  }

  /** URL prefix every site link starts with. */
  get publicBase() {
    return this.customPublicBase ?? this.defaultPublicBase
  }

  /** Panel settings, kept out of the public root. */
  get settingsFile() {
    return path.join(this.stateRoot, 'settings.json')
  }

  /** Manifests of published sites, kept out of the public root. */
  get sitesDir() {
    return path.join(this.stateRoot, 'sites')
  }

  /** Partially copied sites, kept out of the public root. */
  get stagingDir() {
    return path.join(this.stateRoot, 'staging')
  }

  /** Previous generations, kept out of the public root. */
  get trashDir() {
    return path.join(this.stateRoot, 'trash')
  }

  /** Create every directory once and load the saved prefix. */
  async init() {
    if (this.ready === null) {
      this.ready = (async () => {
        await mkdir(this.root, { recursive: true })
        await mkdir(this.sitesDir, { recursive: true })
        await mkdir(this.stagingDir, { recursive: true })
        await mkdir(this.trashDir, { recursive: true })
        try {
          const saved = JSON.parse(await readFile(this.settingsFile, 'utf8'))
          if (typeof saved?.publicBase === 'string' && saved.publicBase !== '') {
            this.customPublicBase = normalizePublicBase(saved.publicBase)
          }
        } catch {
          // No saved prefix yet, or an unreadable one: keep the row config.
        }
      })().catch((error) => {
        // A failed first init must be retryable; a cached rejected promise
        // would keep every later request failing with the same error.
        this.ready = null
        throw error
      })
    }
    return await this.ready
  }

  /**
   * Save the URL prefix site links use; an empty value restores the row config.
   * @param value - e.g. `https://pages.example.com` or `https://dsh.example.com/p`.
   * @returns the prefix now in effect.
   */
  async setPublicBase(value, options = {}) {
    await this.init()
    const text = String(value ?? '').trim()
    const rejection = publicBaseRejection(text, options.panelHost)
    if (rejection !== null) {
      const error = new Error(`该前缀不能使用：${rejection}。请填写站点实际的对外地址。`)
      error.appCode = 'base-forbidden'
      throw error
    }
    this.customPublicBase = text === '' ? null : normalizePublicBase(text)
    const staging = `${this.settingsFile}.${process.pid}.tmp`
    await writeFile(staging, `${JSON.stringify({ publicBase: this.customPublicBase ?? '' }, null, 2)}\n`)
    await rename(staging, this.settingsFile)
    return this.publicBase
  }

  /** Run one mutating operation after the previous one has finished. */
  serialized(work) {
    const next = this.queue.then(work, work)
    this.queue = next.then(() => {}, () => {})
    return next
  }

  /** Public URL of one site. */
  urlOf(slug) {
    return `${this.publicBase}/${slug}/`
  }

  /** Reject a slug that could escape the publish root. */
  assertSlug(slug) {
    if (!SLUG.test(slug)) {
      throw new Error(`无效的 slug「${slug}」：只能用小写字母、数字、点、短横线和下划线（1-41 字符）`)
    }
    const target = path.resolve(this.root, slug)
    if (path.dirname(target) !== this.root) throw new Error(`无效的 slug「${slug}」`)
    return target
  }

  /** Read every manifest, and adopt directories that have none. */
  async list() {
    await this.init()
    const records = new Map()
    let names = []
    try {
      names = await readdir(this.sitesDir)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(await readFile(path.join(this.sitesDir, name), 'utf8'))
        if (record && typeof record.slug === 'string') records.set(record.slug, record)
      } catch {
        // A damaged manifest must not hide the site itself.
      }
    }
    let directories = []
    try {
      directories = await readdir(this.root, { withFileTypes: true })
    } catch {
      directories = []
    }
    for (const entry of directories) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || !SLUG.test(entry.name)) continue
      if (records.has(entry.name)) continue
      records.set(entry.name, { slug: entry.name, title: entry.name, version: 1 })
    }
    const sites = []
    for (const record of records.values()) {
      const directory = path.join(this.root, record.slug)
      let info = null
      try {
        info = await stat(directory)
      } catch {
        info = null
      }
      if (info === null || !info.isDirectory()) continue
      sites.push({
        slug: record.slug,
        title: record.title || record.slug,
        url: this.urlOf(record.slug),
        bytes: Number(record.bytes) || 0,
        files: Number(record.files) || 0,
        version: Number(record.version) || 1,
        publishedAt: record.publishedAt || info.mtime.toISOString(),
      })
    }
    sites.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    return sites
  }

  /**
   * Copy one built site into the publish root and swap it in.
   * @param request - source directory, optional slug and title.
   * @returns the stored record.
   */
  publish(input) {
    return this.serialized(() => this.publishNow(input))
  }

  /** Body of {@link publish}; callers go through the queue. */
  async publishNow({ source, slug, title }) {
    await this.init()
    if (typeof source !== 'string' || source.trim() === '') throw new Error('必须指定源目录')
    const from = path.resolve(source.trim())
    let sourceInfo
    try {
      sourceInfo = await lstat(from)
    } catch {
      throw new Error(`源目录不存在：${from}`)
    }
    if (sourceInfo.isSymbolicLink()) throw new Error(`源目录不能是符号链接：${from}`)
    if (!sourceInfo.isDirectory()) throw new Error(`源路径不是目录：${from}`)

    const [realSource, realRoot, realState] = await Promise.all([
      realpath(from),
      realpath(this.root),
      realpath(this.stateRoot),
    ])
    const protectedPath = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`)
    if (protectedPath(realRoot, realSource) || protectedPath(realState, realSource)
      || protectedPath(realSource, realRoot) || protectedPath(realSource, realState)) {
      throw new Error('源目录不能与发布目录或状态目录互相包含')
    }

    let files = 0
    let bytes = 0
    for await (const entry of walk(realSource)) {
      files += 1
      bytes += entry.size
      if (files > this.maxFiles) throw new Error(`站点文件数超过 ${this.maxFiles} 个`)
    }
    if (bytes > this.maxMb * 1048576) {
      throw new Error(`站点体积 ${formatBytes(bytes)}，超过 ${this.maxMb} MB 上限`)
    }
    const index = await lstat(path.join(realSource, 'index.html')).catch(() => null)
    if (!index?.isFile()) throw new Error(`源目录顶层缺少 index.html：${from}`)

    const resolvedSlug = this.normalizeSlug(slug ?? path.basename(from))
    const target = this.assertSlug(resolvedSlug)
    // mkdtemp is atomic in the kernel: two publishes of one slug can never pick
    // the same staging directory, which `lstat`-then-create could not promise.
    const stage = await mkdtemp(path.join(this.stagingDir, `${resolvedSlug}-`))
    let staged = false
    let activated = false
    let retired = null

    try {
      let skipped = 0
      await cp(realSource, stage, {
        recursive: true,
        force: true,
        dereference: false,
        filter: async (file) => {
          const relative = path.relative(realSource, file)
          if (relative !== '' && NEVER_PUBLISH.test(relative)) {
            skipped += 1
            return false
          }
          return !(await lstat(file)).isSymbolicLink()
        },
      })
      staged = true
      await this.relax(stage)
      await this.sanitize(stage)

      // The pre-copy walk enforces the limits on the source; what actually ships
      // is the staged copy after sanitize drops source maps, so measure that.
      let servedFiles = 0
      let servedBytes = 0
      for await (const entry of walk(stage)) {
        servedFiles += 1
        servedBytes += entry.size
      }
      // The source can grow between the pre-copy walk and this one (a build
      // still running). What ships is the staged copy, so the limit is applied
      // there too — before anything is swapped in.
      if (servedFiles > this.maxFiles) throw new Error(`站点文件数超过 ${this.maxFiles} 个`)
      if (servedBytes > this.maxMb * 1048576) {
        throw new Error(`站点体积 ${formatBytes(servedBytes)}，超过 ${this.maxMb} MB 上限`)
      }

      const previous = await this.readManifest(resolvedSlug)
      const nextTitle = (title && title.trim()) || (await this.titleOf(stage)) || resolvedSlug
      const existing = await lstat(target).catch(() => null)
      if (existing !== null) {
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw new Error(`发布目标不是普通目录：${target}`)
        }
        retired = await uniquePath(this.trashDir, `${resolvedSlug}@${stamp()}`)
        await rename(target, retired)
      }

      const record = {
        slug: resolvedSlug,
        title: nextTitle,
        url: this.urlOf(resolvedSlug),
        bytes: servedBytes,
        files: servedFiles,
        version: (Number(previous?.version) || 0) + 1,
        publishedAt: new Date().toISOString(),
        source: from,
        skipped,
      }
      try {
        await rename(stage, target)
        staged = false
        activated = true
        await this.writeManifest(record)
      } catch (error) {
        // Best-effort restoration: retain both the old directory and its manifest.
        if (activated) {
          await rename(target, stage).then(() => { staged = true }).catch(() => {})
        }
        if (retired !== null) await rename(retired, target).catch(() => {})
        throw error
      }
      if (retired !== null) await this.rotate(resolvedSlug)
      return record
    } finally {
      if (staged) await rm(stage, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Move one site out of the publish root. */
  remove(slug) {
    return this.serialized(() => this.removeNow(slug))
  }

  /** Body of {@link remove}; callers go through the queue. */
  async removeNow(slug) {
    await this.init()
    const resolved = this.normalizeSlug(slug)
    const target = this.assertSlug(resolved)
    let info = null
    try {
      info = await stat(target)
    } catch {
      info = null
    }
    if (info === null || !info.isDirectory()) return { slug: resolved, deleted: false }
    await rename(target, await uniquePath(this.trashDir, `${resolved}@${stamp()}`))
    await rm(path.join(this.sitesDir, `${resolved}.json`), { force: true })
    // Publish rotates the trash; without the same call here, publishing and
    // deleting the same site over and over grows full copies forever.
    await this.rotate(resolved)
    return { slug: resolved, deleted: true }
  }

  /** Normalize a user-supplied segment. */
  normalizeSlug(value) {
    const slug = String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
    if (slug === '') throw new Error('必须填写 slug')
    return slug
  }

  /** Make the copy world-readable: the file service may not run as this user. */
  async relax(directory) {
    await chmod(directory, 0o755)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await this.relax(file)
      } else if (entry.isFile()) {
        await chmod(file, 0o644)
      }
    }
  }

  /** Drop source maps and refuse root-absolute asset links. */
  async sanitize(directory) {
    const offenders = []
    for await (const entry of walk(directory)) {
      if (/\.(?:js|css)\.map$/.test(entry.file)) {
        await rm(entry.file, { force: true })
        continue
      }
      if (!entry.file.endsWith('.html') || entry.size > MAX_HTML_SCAN_BYTES) continue
      const text = await readFile(entry.file, 'utf8').catch(() => '')
      if (ROOT_LINK.test(text)) offenders.push(path.relative(directory, entry.file))
    }
    if (offenders.length > 0) {
      await rm(directory, { recursive: true, force: true })
      throw new Error(
        `发现根路径资源引用：${offenders.slice(0, 5).join(', ')}；站点挂在 ${this.publicBase}/ 下，构建时请用相对路径（Vite 的 base: './'）`,
      )
    }
  }

  /** Read the page title. */
  async titleOf(directory) {
    try {
      const html = await readFile(path.join(directory, 'index.html'), 'utf8')
      const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
      return match ? match[1].replace(/\s+/g, ' ').trim().slice(0, 80) : ''
    } catch {
      return ''
    }
  }

  /** Read one manifest. */
  async readManifest(slug) {
    try {
      return JSON.parse(await readFile(path.join(this.sitesDir, `${slug}.json`), 'utf8'))
    } catch {
      return null
    }
  }

  /** Write one manifest atomically. */
  async writeManifest(record) {
    const file = path.join(this.sitesDir, `${record.slug}.json`)
    const temporary = `${file}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }

  /** Keep only the newest generations of one slug in the trash. */
  async rotate(slug) {
    let names = []
    try {
      names = await readdir(this.trashDir)
    } catch {
      return
    }
    const mine = names
      .filter((name) => name.startsWith(`${slug}@`))
      .sort()
      .reverse()
    for (const name of mine.slice(this.keep)) {
      await rm(path.join(this.trashDir, name), { recursive: true, force: true })
    }
  }
}
