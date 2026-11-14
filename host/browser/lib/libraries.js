/**
 * Rootless runtime libraries for the downloaded browser.
 *
 * Chrome for Testing links against roughly two dozen system libraries that a
 * slim container does not ship, and installing them needs root. Instead of
 * asking the operator for that, the plugin resolves the needed Debian packages
 * from the distribution index, downloads them, and unpacks them into its own
 * directory under DSH_HOME. Launching the browser with `LD_LIBRARY_PATH`
 * pointing there needs no privileges and never touches the host filesystem.
 *
 * Core libraries (libc, libstdc++) are deliberately left to the host: mixing a
 * second glibc into the search path is a reliable way to crash the browser.
 * @module @local/browser-control/libraries
 */
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'

const execFileAsync = promisify(execFile)

/** Shared-library soname → Debian package that provides it. */
export const SONAME_PACKAGES = {
  'libglib-2.0.so.0': 'libglib2.0-0',
  'libgobject-2.0.so.0': 'libglib2.0-0',
  'libgio-2.0.so.0': 'libglib2.0-0',
  'libnspr4.so': 'libnspr4',
  'libnss3.so': 'libnss3',
  'libnssutil3.so': 'libnss3',
  'libsmime3.so': 'libnss3',
  'libatk-1.0.so.0': 'libatk1.0-0',
  'libatk-bridge-2.0.so.0': 'libatk-bridge2.0-0',
  'libatspi.so.0': 'libatspi2.0-0',
  'libdbus-1.so.3': 'libdbus-1-3',
  'libcups.so.2': 'libcups2',
  'libxcb.so.1': 'libxcb1',
  'libxkbcommon.so.0': 'libxkbcommon0',
  'libasound.so.2': 'libasound2',
  'libgbm.so.1': 'libgbm1',
  'libdrm.so.2': 'libdrm2',
  'libxshmfence.so.1': 'libxshmfence1',
  'libexpat.so.1': 'libexpat1',
  'libfreetype.so.6': 'libfreetype6',
  'libfontconfig.so.1': 'libfontconfig1',
  'libharfbuzz.so.0': 'libharfbuzz0b',
  'libpng16.so.16': 'libpng16-16',
  'libEGL.so.1': 'libegl1',
  'libGL.so.1': 'libgl1',
  'libX11.so.6': 'libx11-6',
  'libXext.so.6': 'libxext6',
  'libXcomposite.so.1': 'libxcomposite1',
  'libXdamage.so.1': 'libxdamage1',
  'libXfixes.so.3': 'libxfixes3',
  'libXrandr.so.2': 'libxrandr2',
  'libcairo.so.2': 'libcairo2',
  'libpango-1.0.so.0': 'libpango-1.0-0',
}

/** Fonts that make screenshots readable instead of boxes. */
export const FONT_PACKAGES = ['fonts-liberation']

/** Optional CJK fonts; a page of Chinese text is unreadable without them. */
export const CJK_FONT_PACKAGES = ['fonts-noto-cjk']

/**
 * Packages that must come from the host, never from the side-by-side sysroot.
 * A second libc on the search path breaks the browser in confusing ways.
 */
export const HOST_PROVIDED = new Set(['libc6', 'libgcc-s1', 'libstdc++6', 'zlib1g', 'libtinfo6'])

/**
 * Collect missing shared-library names from loader or `ldd` output.
 * @param text - stderr, or `ldd` stdout.
 * @returns unique sonames, in first-seen order.
 */
export function missingLibraries(text) {
  const found = []
  for (const line of String(text ?? '').split('\n')) {
    const notFound = /^\s*(\S+)\s*=>\s*not found/m.exec(line)
    const loader = /error while loading shared libraries:\s*([^:\s]+)/.exec(line)
    const name = notFound?.[1] ?? loader?.[1]
    if (name !== undefined && !found.includes(name)) found.push(name)
  }
  return found
}

/**
 * Turn missing sonames into the packages that provide them.
 * @param sonames - names from the loader.
 * @returns sorted Debian package names.
 */
export function packagesFor(sonames, extras = []) {
  const packages = new Set([...FONT_PACKAGES, ...extras])
  for (const soname of sonames) {
    const known = SONAME_PACKAGES[soname]
    if (known !== undefined) packages.add(known)
  }
  return [...packages].sort()
}

/** Shell command that installs those packages on a Debian/Ubuntu image. */
export function installCommand(packages) {
  if (!Array.isArray(packages) || packages.length === 0) return ''
  return `apt-get update && apt-get install -y --no-install-recommends ${packages.join(' ')}`
}

/** Debian architecture name for a Node architecture. */
export function debArchitecture(arch = process.arch) {
  if (arch === 'arm64') return 'arm64'
  if (arch === 'x64') return 'amd64'
  throw new Error(`no Debian packages are available for ${arch}`)
}

/** Multiarch library directory inside the sysroot. */
export function debTriplet(arch = process.arch) {
  if (arch === 'arm64') return 'aarch64-linux-gnu'
  if (arch === 'x64') return 'x86_64-linux-gnu'
  throw new Error(`no multiarch triplet for ${arch}`)
}

/**
 * Parse a Debian `Packages` index into the fields the resolver needs.
 * @param text - the decompressed index.
 * @returns package name → `{ filename, depends }`.
 */
export function parsePackagesIndex(text) {
  const packages = new Map()
  for (const stanza of String(text ?? '').split('\n\n')) {
    if (stanza.trim() === '') continue
    const fields = {}
    let key = null
    for (const line of stanza.split('\n')) {
      if (line.startsWith(' ') && key !== null) continue
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      key = line.slice(0, separator)
      fields[key] = line.slice(separator + 1).trim()
    }
    const name = fields.Package
    if (typeof name !== 'string' || name === '') continue
    packages.set(name, { filename: fields.Filename, depends: `${fields['Pre-Depends'] ?? ''},${fields.Depends ?? ''}` })
  }
  return packages
}

/**
 * Close the dependency set of a few root packages.
 * @param index - parsed index.
 * @param roots - package names to start from.
 * @returns sorted package names that have a downloadable file.
 */
export function resolveClosure(index, roots) {
  const seen = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.pop()
    if (seen.has(name) || HOST_PROVIDED.has(name)) continue
    const entry = index.get(name)
    if (entry === undefined || typeof entry.filename !== 'string') continue
    seen.add(name)
    for (const alternative of entry.depends.split(',')) {
      const first = alternative.split('|')[0].trim().split(' ')[0].trim()
      if (first !== '' && !seen.has(first)) queue.push(first)
    }
  }
  return [...seen].sort()
}

/** Download one URL to a file, replacing it. */
async function download(url, destination, fetchImpl, timeoutMs = 120000) {
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}: ${url}`)
  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.part`
  await pipeline(response.body, createWriteStream(temporary))
  await rename(temporary, destination)
}

/** Debian release codename and suite for this host, when it is Debian-like. */
export async function debianSuite(options = {}) {
  if (options.suite !== undefined) return options.suite
  try {
    const text = await readFile(options.osRelease ?? '/etc/os-release', 'utf8')
    const codename = /^VERSION_CODENAME=(.+)$/m.exec(text)?.[1]?.replace(/"/g, '').trim()
    if (codename !== undefined && codename !== '') return codename
  } catch { /* not a distribution file */ }
  return 'bookworm'
}

/**
 * Directory holding the side-by-side runtime.
 * @param home - DSH_HOME.
 */
export function libraryRoot(home) {
  return path.join(home, 'browser-runtime', 'sysroot')
}

/**
 * Environment additions that make the sysroot visible to the browser.
 * @param home - DSH_HOME.
 * @param arch - Node architecture.
 * @returns `{ LD_LIBRARY_PATH?, FONTCONFIG_FILE? }`, empty when not installed.
 */
export async function libraryEnvironment(home, arch = process.arch) {
  const root = libraryRoot(home)
  const triplet = debTriplet(arch)
  const candidates = [path.join(root, 'usr/lib', triplet), path.join(root, 'lib', triplet)]
  const dirs = []
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) dirs.push(candidate)
    } catch { /* not extracted */ }
  }
  if (dirs.length === 0) return {}
  const env = { LD_LIBRARY_PATH: dirs.join(':') }
  const fontsConfig = path.join(root, 'etc', 'fonts', 'yukari-fonts.conf')
  try {
    await stat(fontsConfig)
    env.FONTCONFIG_FILE = fontsConfig
  } catch { /* fonts are optional */ }
  return env
}

/**
 * Download and unpack everything the browser needs into DSH_HOME.
 * @param options - executablePath, home, missing sonames, and seams.
 * @returns `{ packages, environment }` describing what was installed.
 */
export async function installRuntimeLibraries(options) {
  const home = options.home
  const arch = options.arch ?? process.arch
  const fetchImpl = options.fetch ?? globalThis.fetch
  const execute = options.execFile ?? execFileAsync
  const log = options.log ?? (() => {})
  const root = libraryRoot(home)
  const triplet = debTriplet(arch)
  const debianArch = debArchitecture(arch)
  const suite = await debianSuite(options)
  const indexDir = path.join(root, '.index')
  const indexFile = path.join(indexDir, `Packages-${suite}-${debianArch}.gz`)
  const debDir = path.join(root, '.debs')
  await mkdir(indexDir, { recursive: true })
  await mkdir(debDir, { recursive: true })

  const fresh = await stat(indexFile).then((info) => Date.now() - info.mtimeMs < 7 * 86400000).catch(() => false)
  if (!fresh) {
    log(`fetching the ${suite}/${debianArch} package index`)
    const mirror = options.mirror ?? 'https://deb.debian.org/debian'
    await download(`${mirror}/dists/${suite}/main/binary-${debianArch}/Packages.gz`, indexFile, fetchImpl, 120000)
  }
  const { gunzipSync } = await import('node:zlib')
  const index = parsePackagesIndex(gunzipSync(await readFile(indexFile)).toString('utf8'))

  const extras = options.cjkFonts === false ? [] : CJK_FONT_PACKAGES
  const roots = packagesFor(options.missing ?? [], extras)
  const wanted = resolveClosure(index, roots)
  if (wanted.length === 0) throw new Error('the Debian index resolved no packages for the missing libraries')

  for (const name of wanted) {
    const entry = index.get(name)
    const file = path.join(debDir, path.basename(entry.filename))
    try {
      await stat(file)
    } catch {
      log(`fetching ${name}`)
      await download(`https://deb.debian.org/debian/${entry.filename}`, file, fetchImpl, 180000)
    }
    await execute('dpkg-deb', ['-x', file, root], { timeout: 120000 }).catch((error) => {
      throw new Error(`cannot unpack ${name}: ${error instanceof Error ? error.message : String(error)} (dpkg-deb is required)`)
    })
  }

  const fontDirs = [path.join(root, 'usr/share/fonts')]
  const present = []
  for (const dir of fontDirs) {
    try {
      if ((await readdir(dir)).length > 0) present.push(dir)
    } catch { /* no fonts extracted */ }
  }
  const fontsConfig = path.join(root, 'etc', 'fonts', 'yukari-fonts.conf')
  if (present.length > 0) {
    await mkdir(path.dirname(fontsConfig), { recursive: true })
    const cacheDir = path.join(root, 'fontcache')
    await mkdir(cacheDir, { recursive: true })
    const body = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
      '<fontconfig>',
      ...present.map((dir) => `  <dir>${dir}</dir>`),
      `  <cachedir>${cacheDir}</cachedir>`,
      '</fontconfig>',
      '',
    ].join('\n')
    await writeFile(fontsConfig, body, 'utf8')
  }

  const environment = await libraryEnvironment(home, arch)
  if (environment.LD_LIBRARY_PATH === undefined) {
    throw new Error(`libraries were unpacked but ${triplet} is not present under ${root}`)
  }
  return { packages: wanted.length, environment, root }
}

/** Remove the downloaded sysroot (used when a retry wants a clean start). */
export async function clearRuntimeLibraries(home) {
  await rm(libraryRoot(home), { recursive: true, force: true }).catch(() => {})
}
