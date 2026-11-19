/**
 * Filesystem side of static-site publishing.
 *
 * The publish root is the directory the web server exposes under one path
 * prefix, so everything inside it is public. Manifests, staging and trash
 * therefore live outside the root, under the state directory, and never reach
 * the Web.
 * @module @local/publish-sites/lib/sites
 */
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appError } from '../../shared/http.js'

/** Allowed URL segment. */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,40}$/

/** Bound recursive copies as well as total bytes. */
const DEFAULT_MAX_FILES = 10000

/** Directory under the user's home used when the row names no publish root. */
const DEFAULT_ROOT_NAME = 'publish'

/**
 * Publish roots that earlier versions of this component shipped as their default.
 *
 * 默认根改成 `~/publish` 之后，升级上来的安装会对着一个空目录：站点还在旧目录里，
 * 面板却列不出来。启动时按这份名单接管旧目录，不搬、不删。这是迁移名单，不是配置项。
 */
const LEGACY_DEFAULT_ROOTS = ['/workspace/publish']

/**
 * Path the Host answers published sites from when nothing else is configured.
 *
 * 相对路径，由面板拼上当前来源：换个部署、换个端口都不用改配置。
 */
export const DEFAULT_SITE_PATH = '/p'

/** One segment of the mount path; the same alphabet as a slug. */
const PATH_SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/

/**
 * Prefixes the Host or another component already answers.
 *
 * 只列本仓库能确定会被占用的前缀：别的组件、别的插件注册的路由在这里看不全，
 * 所以真正的冲突判断靠注册本身（`path-taken`），这份名单只是提前给个明确的理由。
 */
const RESERVED_PATHS = ['/api', '/plugins', '/publish']

/** An asset reference that resolves against the origin root instead of the site. */
const ROOT_LINK = /(?:src|href)\s*=\s*["']\/[^/"']/i

/** Skip absurdly large HTML files when scanning for root links. */
const MAX_HTML_SCAN_BYTES = 4 * 1024 * 1024

/** Read one positive number from config. */
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback
}

/** Human-readable byte count: small sites are the common case, so KB before MB. */
export function formatBytes(bytes) {
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
 * Normalize one mount path. Empty means "use the default"; trailing slashes
 * and surrounding whitespace are dropped.
 * @param value - user input.
 * @returns the path without a trailing slash, always starting with `/`.
 */
export function normalizeSitePath(value) {
  const text = String(value ?? '').trim()
  if (text === '') return DEFAULT_SITE_PATH
  return text.replace(/\/+$/, '') || DEFAULT_SITE_PATH
}

/**
 * Why a mount path cannot be used, or null when it can.
 *
 * 路径就是站点对外的前缀，所以每个段都按 slug 的字母表限定：大小写、点段、
 * 百分号编码、查询串在路由前缀匹配里都没有意义，只会让人误以为能写出 URL。
 *
 * 返回码而不是一句话：面板按码给自己的措辞，服务端这句只做日志与兜底。
 * @param value - path text from the panel or the row config.
 * @returns `{ code, reason }`，可用时返回 null。
 */
export function sitePathRejection(value) {
  const text = String(value ?? '').trim()
  if (text === '') return null
  if (!text.startsWith('/')) return { code: 'path-invalid', reason: '路径必须以 / 开头' }
  if (text.includes('//') || /[\\?#%\s]/.test(text)) return { code: 'path-invalid', reason: '路径里不能有空段、反斜杠、空格或 ? # %' }
  const trimmed = text.replace(/\/+$/, '')
  if (trimmed === '') return { code: 'path-reserved', reason: '根路径由宿主提供' }
  for (const segment of trimmed.slice(1).split('/')) {
    if (!PATH_SEGMENT.test(segment)) {
      return { code: 'path-invalid', reason: `路径段「${segment}」只能用小写字母、数字、点、短横线和下划线` }
    }
  }
  for (const reserved of RESERVED_PATHS) {
    if (trimmed === reserved || trimmed.startsWith(`${reserved}/`)) {
      return { code: 'path-reserved', reason: `「${reserved}」由宿主保留` }
    }
  }
  return null
}

/**
 * Mount path saved in settings.json, or null when the file names none.
 *
 * 0.7.8 及更早存的是 `publicBase`：一个完整地址，其中路径就是当时对外的前缀
 * （反代改写路径时唯一能配置的东西）。现在挂载路径本身就是对外路径，所以把那段
 * 路径一次性迁移成 `path`，链接和路由都跟着走；没有路径的旧值迁移后就是默认。
 * @param saved - parsed settings.json.
 */
function savedSitePath(saved) {
  if (typeof saved?.path === 'string') {
    const text = saved.path.trim()
    return text === '' || sitePathRejection(text) !== null ? null : normalizeSitePath(text)
  }
  if (typeof saved?.publicBase === 'string' && saved.publicBase.trim() !== '') {
    try {
      const url = new URL(saved.publicBase.trim())
      const pathname = url.pathname
      return pathname === '/' || sitePathRejection(pathname) !== null ? null : normalizeSitePath(pathname)
    } catch {
      return null
    }
  }
  return null
}

/** Names that must never be served from the publish root. */
const NEVER_PUBLISH = /(^|\/)(\.git|\.env[^/]*|node_modules)(\/|$)|(^|\/)[^/]+\.(pem|key|p12|pfx)$/

export class SiteStore {
  /**
   * @param config - root, stateRoot, path, maxMb, keep, legacyRoots.
   */
  constructor(config = {}) {
    // 空字符串是「没配」，不是「当前目录」：path.resolve('') 会落到 cwd。
    const configuredRoot = String(config.root ?? '').trim()
    /** 用户显式配了目录时一律照用，不猜测旧位置。 */
    this.explicitRoot = configuredRoot !== ''
    this.explicitStateRoot = String(config.stateRoot ?? '').trim() !== ''
    const root = path.resolve(configuredRoot === '' ? path.join(os.homedir(), DEFAULT_ROOT_NAME) : configuredRoot)
    this.root = root
    this.stateRoot = path.resolve(String(config.stateRoot ?? path.join(path.dirname(root), '.publish-state')))
    /** 接管来的旧发布目录；面板据此说明为什么路径与默认值不同。 */
    this.adoptedFrom = null
    this.legacyRoots = Array.isArray(config.legacyRoots) && config.legacyRoots.length > 0
      ? config.legacyRoots.map((value) => path.resolve(String(value)))
      : LEGACY_DEFAULT_ROOTS.map((value) => path.resolve(value))
    const configuredPath = String(config.path ?? '').trim()
    /** 行配置里写错的路径不能拖垮启动：记下原因，按默认路径提供。 */
    this.rowPathRejection = sitePathRejection(configuredPath)
    this.defaultSitePath = this.rowPathRejection === null ? normalizeSitePath(configuredPath) : DEFAULT_SITE_PATH
    /** Path saved from the panel; overrides the row config when set. */
    this.customSitePath = null
    /** 保存的路径挂不上（被别的组件占了）时退回默认，这里记下原本想要的路径。 */
    this.pathFallback = null
    this.maxMb = positive(config.maxMb, 200)
    this.maxFiles = positive(config.maxFiles, DEFAULT_MAX_FILES)
    this.keep = positive(config.keep, 5)
    this.ready = null
    /** Mutations run one at a time: staging, trash and manifests are shared. */
    this.queue = Promise.resolve()
  }

  /** Path prefix every site link starts with. */
  get sitePath() {
    return this.customSitePath ?? this.defaultSitePath
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

  /**
   * Keep using the directory an older default pointed at.
   *
   * 只在新目录里一张站点清单都没有、且用户没显式配 root 时接管：文件原地不动，
   * 旧目录继续对外提供，不需要重新发布。
   * @returns the adopted root, or null.
   */
  async #adoptLegacyRoot() {
    if (this.explicitRoot) return null
    if (await this.#hasManifests(this.stateRoot)) return null
    for (const candidate of this.legacyRoots) {
      if (candidate === this.root) continue
      const stateRoot = path.join(path.dirname(candidate), '.publish-state')
      if (!(await this.#hasManifests(stateRoot))) continue
      this.root = candidate
      if (!this.explicitStateRoot) this.stateRoot = stateRoot
      this.adoptedFrom = candidate
      return candidate
    }
    return null
  }

  /** Whether one state directory already holds site manifests. */
  async #hasManifests(stateRoot) {
    try {
      const entries = await readdir(path.join(stateRoot, 'sites'))
      return entries.some((name) => name.endsWith('.json'))
    } catch {
      return false
    }
  }

  /** Create every directory once and load the saved prefix. */
  async init() {
    if (this.ready === null) {
      this.ready = (async () => {
        await this.#adoptLegacyRoot()
        // 发布根现在由宿主直接对外提供：状态目录落在里面，清单和 settings.json
        // 就成了公开文件。默认名 `.publish-state` 能靠隐藏规则挡住，自定义的名字不能。
        const inside = path.relative(this.root, this.stateRoot)
        if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
          throw new Error(`状态目录不能位于发布目录内：${this.stateRoot}`)
        }
        await mkdir(this.root, { recursive: true })
        await mkdir(this.sitesDir, { recursive: true })
        await mkdir(this.stagingDir, { recursive: true })
        await mkdir(this.trashDir, { recursive: true })
        try {
          const saved = JSON.parse(await readFile(this.settingsFile, 'utf8'))
          this.customSitePath = savedSitePath(saved)
        } catch {
          // No saved path yet, or an unreadable one: keep the row config.
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
   * Save the mount path the Host answers published sites from.
   *
   * 三件事必须一起成立：settings.json、内存里的路径、宿主上的路由。所以先换路由
   * （它可能因为路径被占用而失败），再写盘；写盘失败就把路由换回去。整个动作走
   * 同一个队列，两个面板同时保存时不会交叉。
   * @param value - e.g. `/sites`; an empty value restores the row config.
   * @param mount - swaps the live route to the given path; throws when the path is taken.
   * @returns the path now in effect.
   */
  setSitePath(value, mount = null) {
    return this.serialized(() => this.applySitePath(value, mount))
  }

  /** Body of {@link setSitePath}; callers go through the queue. */
  async applySitePath(value, mount) {
    await this.init()
    const text = String(value ?? '').trim()
    const rejection = sitePathRejection(text)
    if (rejection !== null) throw appError(`站点路径不可用：${rejection.reason}`, rejection.code)
    const next = text === '' ? null : normalizeSitePath(text)
    const previous = this.customSitePath
    const target = next ?? this.defaultSitePath
    const moved = mount !== null && target !== this.sitePath
    // 启动时退回默认路径的那次失败也要能被清掉：这时内存里没有自定义值，
    // 但盘上还留着挂不上的路径。
    const dirty = next !== previous || this.pathFallback !== null
    if (moved) mount(target)
    try {
      if (dirty) await this.#writeSettings(next)
    } catch (error) {
      // 路由已经换过去了，盘上的值没写成：两边必须回到同一个状态。
      if (moved) {
        try {
          mount(this.sitePath)
        } catch {
          this.pathFallback = { path: target }
        }
      }
      throw error
    }
    this.customSitePath = next
    this.pathFallback = null
    return this.sitePath
  }

  /** Write settings.json atomically. */
  async #writeSettings(custom) {
    const staging = `${this.settingsFile}.${process.pid}.tmp`
    await writeFile(staging, `${JSON.stringify({ path: custom ?? '' }, null, 2)}\n`)
    await rename(staging, this.settingsFile)
  }

  /** Run one mutating operation after the previous one has finished. */
  serialized(work) {
    const next = this.queue.then(work, work)
    this.queue = next.then(() => {}, () => {})
    return next
  }

  /** Public URL of one site, relative to whatever page links it. */
  urlOf(slug) {
    return `${this.sitePath}/${slug}/`
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
        `发现根路径资源引用：${offenders.slice(0, 5).join(', ')}；站点挂在 ${this.sitePath}/ 下，构建时请用相对路径（Vite 的 base: './'）`,
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
