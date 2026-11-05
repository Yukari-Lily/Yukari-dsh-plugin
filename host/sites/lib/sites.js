/**
 * Filesystem side of static-site publishing.
 *
 * The publish root is the directory the web server exposes at `/p/`, so
 * everything inside it is public. Manifests, staging and trash therefore live
 * outside the root, under the state directory, and never reach the Web.
 * @module @local/publish-sites/lib/sites
 */
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Allowed URL segment. */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,40}$/

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

/** Recursive walk yielding `{ file, size }` for every regular file. */
async function* walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      yield* walk(file)
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
      await stat(candidate)
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
    this.keep = positive(config.keep, 5)
    this.ready = null
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
      })()
    }
    return await this.ready
  }

  /**
   * Save the URL prefix site links use; an empty value restores the row config.
   * @param value - e.g. `https://pages.example.com` or `https://dsh.example.com/p`.
   * @returns the prefix now in effect.
   */
  async setPublicBase(value) {
    await this.init()
    const text = String(value ?? '').trim()
    this.customPublicBase = text === '' ? null : normalizePublicBase(text)
    await writeFile(this.settingsFile, `${JSON.stringify({ publicBase: this.customPublicBase ?? '' }, null, 2)}\n`)
    return this.publicBase
  }

  /** Public URL of one site. */
  urlOf(slug) {
    return `${this.publicBase}/${slug}/`
  }

  /** Reject a slug that could escape the publish root. */
  assertSlug(slug) {
    if (!SLUG.test(slug)) {
      throw new Error(`invalid slug "${slug}": use lowercase letters, digits, dot, dash or underscore (1-41 chars)`)
    }
    const target = path.resolve(this.root, slug)
    if (path.dirname(target) !== this.root) throw new Error(`invalid slug "${slug}"`)
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
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
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
  async publish({ source, slug, title }) {
    await this.init()
    if (typeof source !== 'string' || source.trim() === '') throw new Error('source directory is required')
    const from = path.resolve(source.trim())
    let sourceInfo = null
    try {
      sourceInfo = await stat(from)
    } catch {
      throw new Error(`source directory does not exist: ${from}`)
    }
    if (!sourceInfo.isDirectory()) throw new Error(`source is not a directory: ${from}`)
    try {
      await stat(path.join(from, 'index.html'))
    } catch {
      throw new Error(`source has no index.html at its top level: ${from}`)
    }

    const resolvedSlug = this.normalizeSlug(slug ?? path.basename(from))
    const target = this.assertSlug(resolvedSlug)

    let files = 0
    let bytes = 0
    for await (const entry of walk(from)) {
      files += 1
      bytes += entry.size
    }
    if (bytes > this.maxMb * 1048576) {
      throw new Error(`site is ${formatBytes(bytes)}, above the ${this.maxMb} MB limit`)
    }

    const id = `${resolvedSlug}.${stamp()}`
    const stage = path.join(this.stagingDir, id)
    await rm(stage, { recursive: true, force: true })
    await cp(from, stage, { recursive: true, force: true })
    await this.relax(stage)
    await this.sanitize(stage)

    const previous = await this.readManifest(resolvedSlug)
    const nextTitle = (title && title.trim()) || (await this.titleOf(stage)) || resolvedSlug

    let retired = null
    try {
      await stat(target)
      retired = await uniquePath(this.trashDir, id)
      await rename(target, retired)
    } catch {
      retired = null
    }
    await rename(stage, target)

    const record = {
      slug: resolvedSlug,
      title: nextTitle,
      url: this.urlOf(resolvedSlug),
      bytes,
      files,
      version: (Number(previous?.version) || 0) + 1,
      publishedAt: new Date().toISOString(),
      source: from,
    }
    await this.writeManifest(record)
    if (retired !== null) await this.rotate(resolvedSlug)
    return record
  }

  /** Move one site out of the publish root. */
  async remove(slug) {
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
    await rename(target, await uniquePath(this.trashDir, `${resolved}.${stamp()}`))
    await rm(path.join(this.sitesDir, `${resolved}.json`), { force: true })
    return { slug: resolved, deleted: true }
  }

  /** Normalize a user-supplied segment. */
  normalizeSlug(value) {
    const slug = String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
    if (slug === '') throw new Error('slug is required')
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
      if (entry.file.endsWith('.map')) {
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
        `absolute root asset link found in ${offenders.slice(0, 5).join(', ')}: the site is served under ${this.publicBase}/, so build with a relative base (Vite base: './')`,
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
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
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
      .filter((name) => name.startsWith(`${slug}.`))
      .sort()
      .reverse()
    for (const name of mine.slice(this.keep)) {
      await rm(path.join(this.trashDir, name), { recursive: true, force: true })
    }
  }
}
