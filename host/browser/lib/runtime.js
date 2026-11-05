/**
 * Automatic Chrome for Testing provisioning.
 *
 * Only the official Chrome metadata and storage hosts are contacted. Downloads
 * live in DSH_HOME, are bounded and time-limited, and become visible through a
 * same-directory rename only after extraction and executable verification.
 */
import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { extractZipArchive } from './zip.js'

export const METADATA_URL = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json'
const MAX_METADATA_BYTES = 8 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const execFileAsync = promisify(execFile)

/** Map a Node platform/architecture pair to Chrome's archive directory. */
export function chromePlatform(platform = process.platform, architecture = process.arch) {
  const key = `${platform}-${architecture}`
  const supported = {
    'linux-x64': 'linux64',
    'linux-arm64': 'linux-arm64',
    'darwin-x64': 'mac-x64',
    'darwin-arm64': 'mac-arm64',
    'win32-x64': 'win64',
  }
  if (!supported[key]) {
    throw new Error(`Chrome for Testing has no supported ${platform}/${architecture} archive; install Chromium and set browser executablePath`)
  }
  return supported[key]
}

/** Compare two Chrome version strings numerically. */
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number)
  const right = String(b).split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/**
 * Select the newest build carrying the required archive.
 *
 * The channel entry is only a hint: some metadata revisions name the stable
 * version as a bare string, so every version is ranked explicitly instead of
 * trusting the first match (which used to pick the oldest build).
 * @param metadata - known-good-versions document.
 * @param platform - Chrome archive platform id.
 * @returns `{ version, url, revision }`.
 */
export function selectChromeBuild(metadata, platform) {
  if (!metadata || !Array.isArray(metadata.versions)) throw new Error('Chrome for Testing metadata is malformed')
  const stable = typeof metadata.channels?.Stable === 'string' ? metadata.channels.Stable : undefined
  const usable = metadata.versions
    .filter((entry) => Array.isArray(entry?.downloads?.chrome) && entry.version && (!stable || entry.version === stable))
    .filter((entry) => entry.downloads.chrome.some((file) => file.platform === platform && /^https:\/\/storage\.googleapis\.com\//u.test(file.url)))
  if (usable.length === 0) throw new Error(`Chrome for Testing metadata has no ${platform} download`)
  usable.sort((a, b) => compareVersions(b.version, a.version))
  const build = usable[0]
  const download = build.downloads.chrome.find((file) => file.platform === platform)
  return { version: String(build.version), url: download.url, revision: build.revision }
}

/** Location of the browser executable inside an extracted official archive. */
export function executableIn(directory, platform = process.platform, architecture = process.arch) {
  if (platform === 'darwin') return path.join(directory, architecture === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
  if (platform === 'win32') return path.join(directory, 'chrome-win64', 'chrome.exe')
  return path.join(directory, architecture === 'arm64' ? 'chrome-linux-arm64' : 'chrome-linux64', 'chrome')
}

/** Verify that a configured or installed browser is a regular executable. */
export async function verifyExecutable(executablePath) {
  try {
    const details = await stat(executablePath)
    if (!details.isFile()) throw new Error('not a regular file')
    await access(executablePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch (error) {
    throw new Error(`Chromium executable is unusable at ${executablePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Shared-library soname → Debian package that provides it. */
const SONAME_PACKAGES = {
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

/** Packages a headless browser needs even when no soname complained yet. */
const EXTRA_PACKAGES = ['fonts-liberation', 'ca-certificates']

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
export function packagesFor(sonames) {
  const packages = new Set(EXTRA_PACKAGES)
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

/**
 * Check that the installed browser actually starts.
 *
 * A download can complete while the host still lacks shared libraries (a slim
 * container typically misses libglib, libnss3 and friends). Reporting that here
 * turns a silent "ready" into a message naming the exact missing libraries.
 * @param executablePath - the browser binary.
 * @param options - execFile seam and timeout.
 * @returns `{ ok, detail }`.
 */
export async function probeLaunch(executablePath, options = {}) {
  const execute = options.execFile ?? execFileAsync
  try {
    const { stdout, stderr } = await execute(executablePath, ['--version'], { timeout: options.timeoutMs ?? 15000, windowsHide: true })
    const line = String(stdout || stderr).trim().split('\n').pop() ?? ''
    return { ok: true, detail: line }
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim()
    let missing = missingLibraries(detail)
    // The loader stops at the first missing library; `ldd` lists them all.
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execute('ldd', [executablePath], { timeout: options.timeoutMs ?? 15000 })
        const listed = missingLibraries(stdout)
        if (listed.length > 0) missing = listed
      } catch { /* no ldd: keep the loader's single answer */ }
    }
    const packages = missing.length > 0 ? packagesFor(missing) : []
    return {
      ok: false,
      detail,
      missing,
      packages,
      command: installCommand(packages),
      hint: missing.length === 0
        ? ''
        : `missing ${missing.length} runtime libraries; install them (or point browser libraryPath at them)`,
    }
  }
}

/** Download a URL to a file with byte and time limits. */
export async function downloadFile(url, destination, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 120000
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES
  const onProgress = options.onProgress ?? (() => {})
  if (typeof fetchImpl !== 'function') throw new Error('automatic browser installation requires Node.js with fetch support')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`download timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`download exceeds the ${maxBytes}-byte limit`)
    if (!response.body) throw new Error('download response has no body')
    const chunks = []
    let received = 0
    for await (const chunk of response.body) {
      received += chunk.length
      if (received > maxBytes) throw new Error(`download exceeded the ${maxBytes}-byte limit`)
      chunks.push(Buffer.from(chunk))
      onProgress({ received, total: Number.isFinite(declared) ? declared : undefined })
    }
    await writeFile(destination, Buffer.concat(chunks), { flag: 'wx' })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Extract an official ZIP in-process.
 *
 * No system `unzip`, PowerShell, or npm extraction dependency is involved, so
 * automatic installation behaves the same in a slim container and on a desktop.
 * @param archive - the downloaded archive.
 * @param destination - directory to unpack into.
 */
export async function extractZip(archive, destination) {
  await extractZipArchive(archive, destination)
}

/** Shared, observable installer for one browser plugin mount. */
export class BrowserRuntime {
  #config
  #deps
  #promise
  #state = { status: 'idle' }

  constructor(config = {}, dependencies = {}) {
    this.#config = config
    this.#deps = dependencies
    if (config.executablePath) {
      this.#state = { status: 'ready', executablePath: config.executablePath, source: 'configured' }
    }
  }

  state() {
    return { ...this.#state, ...(this.#state.progress ? { progress: { ...this.#state.progress } } : {}) }
  }

  /** Run the launch probe through the injectable seam. */
  #probe(executable) {
    return (this.#deps.probe ?? probeLaunch)(executable)
  }

  /** Re-use the one in-flight installation; callers all await this promise. */
  ensureReady() {
    if (this.#state.status === 'ready') return Promise.resolve(this.#state.executablePath)
    if (this.#promise) return this.#promise
    this.#promise = this.#install()
    return this.#promise
  }

  /** Re-run the launch probe for an already installed browser. */
  async recheck() {
    if (this.#state.status !== 'ready' || !this.#state.executablePath) return this.retry()
    const probe = await (this.#deps.probe ?? probeLaunch)(this.#state.executablePath)
    this.#state = { ...this.#state, launch: probe }
    return this.#state.executablePath
  }

  retry() {
    if (this.#state.status === 'ready') return this.recheck()
    if (this.#state.status !== 'installing') this.#promise = undefined
    return this.ensureReady()
  }

  async #install() {
    this.#state = { status: 'installing', progress: { stage: 'metadata' } }
    const progress = (value) => {
      this.#state = { ...this.#state, progress: { ...this.#state.progress, ...value } }
    }
    try {
      const platform = chromePlatform(this.#deps.platform ?? process.platform, this.#deps.arch ?? process.arch)
      const home = this.#deps.home ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
      const root = path.join(home, 'browser-runtime')
      const metadataFile = path.join(root, `metadata-${process.pid}-${Date.now()}.json`)
      await mkdir(root, { recursive: true })
      try {
        await downloadFile(METADATA_URL, metadataFile, {
          fetch: this.#deps.fetch,
          timeoutMs: this.#config.downloadTimeoutMs ?? 120000,
          maxBytes: MAX_METADATA_BYTES,
        })
        const build = selectChromeBuild(JSON.parse(await readFile(metadataFile, 'utf8')), platform)
        progress({ stage: 'download', version: build.version })
        const destination = path.join(root, 'chrome', build.version, platform)
        const executable = executableIn(destination, this.#deps.platform ?? process.platform, this.#deps.arch ?? process.arch)
        try {
          await verifyExecutable(executable)
          this.#state = { status: 'ready', executablePath: executable, version: build.version, source: 'cache', launch: await this.#probe(executable) }
          return executable
        } catch { /* install this version below */ }
        const staging = await mkdtemp(path.join(root, '.staging-'))
        try {
          const archive = path.join(staging, 'chrome.zip')
          const unpacked = path.join(staging, 'unpacked')
          await mkdir(unpacked)
          await downloadFile(build.url, archive, {
            fetch: this.#deps.fetch,
            timeoutMs: this.#config.downloadTimeoutMs ?? 300000,
            onProgress: ({ received, total }) => progress({ stage: 'download', downloadedBytes: received, totalBytes: total, percent: total ? Math.round(received / total * 100) : undefined }),
          })
          progress({ stage: 'extract' })
          await extractZip(archive, unpacked)
          await verifyExecutable(executableIn(unpacked, this.#deps.platform ?? process.platform, this.#deps.arch ?? process.arch))
          await mkdir(path.dirname(destination), { recursive: true })
          try {
            await rename(unpacked, destination)
          } catch (error) {
            if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
          }
          if (this.#deps.platform !== 'win32') await chmod(executable, 0o755).catch(() => {})
          await verifyExecutable(executable)
          this.#state = { status: 'ready', executablePath: executable, version: build.version, source: 'download', launch: await this.#probe(executable) }
          return executable
        } finally {
          await rm(staging, { recursive: true, force: true })
        }
      } finally {
        await rm(metadataFile, { force: true })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#state = { status: 'error', error: `Automatic Chromium installation failed: ${message}` }
      throw new Error(this.#state.error)
    }
  }
}
