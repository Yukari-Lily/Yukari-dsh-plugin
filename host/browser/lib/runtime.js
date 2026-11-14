/**
 * Automatic Chrome for Testing provisioning.
 *
 * Only the official Chrome metadata and storage hosts are contacted. Downloads
 * live in DSH_HOME, are bounded and time-limited, and become visible through a
 * same-directory rename only after extraction and executable verification.
 */
import { constants, createWriteStream } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { extractZipArchive } from '../../shared/zip.js'
import {
  installCommand, installRuntimeLibraries, libraryEnvironment, missingLibraries, packagesFor,
} from './libraries.js'

export { installCommand, libraryEnvironment, missingLibraries, packagesFor }

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
  const env = { ...process.env, ...(options.env ?? {}) }
  try {
    const { stdout, stderr } = await execute(executablePath, ['--version'], { timeout: options.timeoutMs ?? 15000, windowsHide: true, env })
    const line = String(stdout || stderr).trim().split('\n').pop() ?? ''
    return { ok: true, detail: line }
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim()
    let missing = missingLibraries(detail)
    // The loader stops at the first missing library; `ldd` lists them all.
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execute('ldd', [executablePath], { timeout: options.timeoutMs ?? 15000, env })
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
    // 整包读进内存会在 512MB 上限处把宿主堆打满；直接落盘，用计数流守住上限。
    let received = 0
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > maxBytes) {
          callback(new Error(`download exceeded the ${maxBytes}-byte limit`))
          return
        }
        onProgress({ received, total: Number.isFinite(declared) ? declared : undefined })
        callback(null, chunk)
      },
    })
    try {
      await pipeline(Readable.from(response.body), meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
    } catch (error) {
      // 半写的文件绝不能留到下一次安装：下一次会以为"已经下载过"。
      await rm(destination, { force: true }).catch(() => {})
      throw error
    }
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

  /** Environment additions from the side-by-side runtime, if installed. */
  async environment() {
    if (this.#state.environment !== undefined) return this.#state.environment
    const home = this.#home()
    const env = await libraryEnvironment(home, this.#arch())
    this.#state = { ...this.#state, environment: env }
    return env
  }

  #home() {
    return this.#deps.home ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  }

  #arch() {
    return this.#deps.arch ?? process.arch
  }

  /** Run the launch probe through the injectable seam. */
  async #probe(executable) {
    return (this.#deps.probe ?? probeLaunch)(executable, { env: await this.environment() })
  }

  /**
   * A downloaded browser still needs the libraries the image lacks. When that
   * is the only problem, fetch them into DSH_HOME (no root required) and probe
   * again, so the browser becomes usable without operator action.
   */
  async #ensureLibraries(executable, probe) {
    if (probe?.ok !== false || this.#config.autoLibraries === false) return probe
    if (!Array.isArray(probe.missing) || probe.missing.length === 0) return probe
    if (this.#arch() !== 'arm64' && this.#arch() !== 'x64') return probe
    if (this.#deps.platform !== undefined && this.#deps.platform !== 'linux') return probe
    try {
      const result = await installRuntimeLibraries({
        home: this.#home(),
        arch: this.#arch(),
        missing: probe.missing,
        cjkFonts: this.#config.cjkFonts !== false,
        fetch: this.#deps.fetch,
        execFile: this.#deps.execFile,
        suite: this.#config.debianSuite,
        log: this.#deps.log,
      })
      this.#state = { ...this.#state, environment: result.environment, libraries: { packages: result.packages } }
      return await this.#probe(executable)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#deps.log?.(`runtime libraries could not be installed: ${message}`)
      return { ...probe, librariesError: message }
    }
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
    this.#state = { ...this.#state, environment: undefined }
    const probe = await this.#probe(this.#state.executablePath)
    const checked = await this.#ensureLibraries(this.#state.executablePath, probe)
    this.#state = { ...this.#state, launch: checked }
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
          this.#state = { status: 'ready', executablePath: executable, version: build.version, source: 'cache' }
          const cachedLaunch = await this.#ensureLibraries(executable, await this.#probe(executable))
          this.#state = { ...this.#state, launch: cachedLaunch }
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
          this.#state = { status: 'ready', executablePath: executable, version: build.version, source: 'download' }
          const freshLaunch = await this.#ensureLibraries(executable, await this.#probe(executable))
          this.#state = { ...this.#state, launch: freshLaunch }
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
