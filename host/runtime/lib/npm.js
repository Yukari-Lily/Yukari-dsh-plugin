/**
 * Talking to npm from inside the running Host.
 *
 * Two details make this different from typing `npm i -g` in a shell:
 *
 * - The cache directory has to be ours. The image leaves `/tmp/npm-cache` owned
 *   by root, so an inherited `npm_config_cache` fails every command with EACCES
 *   before it reaches the registry. Every call therefore passes `--cache` at a
 *   path under `DSH_HOME`.
 * - The running copy has to be told apart from the copy on disk. An upgrade
 *   replaces the files under the global prefix while the old modules stay
 *   mapped in memory, so "running" and "installed" are separate numbers until
 *   the process is re-exec'd.
 * @module @local/dsh-control/lib/npm
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** The package this plugin upgrades. */
export const PACKAGE = '@deepseek-ai/dsh'

/** How much command output is kept for the panel. */
const OUTPUT_LIMIT = 24 * 1024

/**
 * Read the manifest at one directory.
 * @param {string} dir - package directory.
 * @returns {Promise<object | null>} parsed manifest, or null when unreadable.
 */
async function readManifest(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Synchronous variant used while walking up the tree at load time. */
function readManifestSync(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Find the Harness package that is currently loaded, by walking up from the
 * entry script. Symlinks are resolved first because `dsh` on PATH is one.
 * @param {string[]} [starts] - alternative starting points, for tests.
 * @returns {{ dir: string, version: string } | undefined} the loaded package.
 */
export function locateRunningPackage(starts = [process.argv[1]]) {
  for (const start of starts) {
    if (typeof start !== 'string' || start === '') continue
    let current
    try {
      current = path.resolve(realpathSync(start))
    } catch {
      continue
    }
    if (!existsSync(current) || readManifestSync(current) === null) {
      // A file: continue from its directory.
      current = path.dirname(current)
    }
    for (let step = 0; step < 8; step += 1) {
      const manifest = readManifestSync(current)
      if (manifest?.name === PACKAGE && typeof manifest.version === 'string') {
        return { dir: current, version: manifest.version }
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return undefined
}

/** Where npm keeps its cache for this plugin. */
export function defaultCacheDir(env = process.env) {
  const home = env.DSH_HOME ?? path.join(env.HOME ?? homedir(), '.dsh')
  return path.join(home, '.dsh-control', 'npm-cache')
}

/** Trim a command's output to its tail. */
function tail(text) {
  const value = String(text ?? '')
  return value.length <= OUTPUT_LIMIT ? value : `…\n${value.slice(value.length - OUTPUT_LIMIT)}`
}

/**
 * Run one executable without a shell, bounded by a timeout.
 * @param {string} file - executable.
 * @param {string[]} args - arguments.
 * @param {{ timeoutMs?: number, env?: object }} options - execution bounds.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} result.
 */
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 8 * 1024 * 1024,
        env: options.env ?? process.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(new Error(error.message))
          return
        }
        resolve({
          code: error === null ? 0 : error.code,
          stdout: tail(stdout),
          stderr: tail(stderr),
        })
      },
    )
  })
}

export class NpmRunner {
  /**
   * @param {{ cacheDir?: string, registry?: string, env?: object }} config - paths and registry.
   */
  constructor(config = {}) {
    this.cacheDir = config.cacheDir ?? defaultCacheDir()
    this.registry = String(config.registry ?? '').trim()
    this.env = {
      ...(config.env ?? process.env),
      npm_config_cache: this.cacheDir,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      npm_config_loglevel: 'error',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    }
    if (this.registry !== '') this.env.npm_config_registry = this.registry
    this.globalRootCache = null
  }

  /** Arguments every npm call shares. */
  baseArgs() {
    const args = ['--cache', this.cacheDir, '--no-fund', '--no-audit', '--loglevel=error']
    if (this.registry !== '') args.push('--registry', this.registry)
    return args
  }

  /** Make sure the cache directory exists and belongs to us. */
  async ready() {
    await mkdir(this.cacheDir, { recursive: true })
  }

  /**
   * The global installation prefix, asked once and remembered. `npm root -g`
   * resolves through npm's own config, which is the only answer that matches
   * where an install will actually land; the derived guess is the fallback.
   * @returns {Promise<string>} absolute path of the global node_modules.
   */
  async globalRoot() {
    if (this.globalRootCache !== null) return this.globalRootCache
    await this.ready()
    let root
    try {
      const result = await run('npm', ['root', '-g', ...this.baseArgs()], { timeoutMs: 30_000, env: this.env })
      const line = result.stdout.trim().split('\n').filter((part) => part !== '').pop()
      if (result.code === 0 && line !== undefined) root = line
    } catch {
      root = undefined
    }
    if (root === undefined) {
      root = path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules')
    }
    this.globalRootCache = root
    return root
  }

  /**
   * Version installed on disk (not necessarily the one running).
   * @returns {Promise<string | null>} version, or null when the package is absent.
   */
  async installedVersion() {
    const root = await this.globalRoot()
    const manifest = await readManifest(path.join(root, PACKAGE))
    return typeof manifest?.version === 'string' ? manifest.version : null
  }

  /**
   * Every published version of the package.
   * @returns {Promise<string[]>} versions.
   */
  async versions() {
    await this.ready()
    const result = await run('npm', ['view', PACKAGE, 'versions', '--json', '--silent', ...this.baseArgs()], {
      timeoutMs: 90_000,
      env: this.env,
    })
    if (result.code !== 0) {
      throw new Error(
        `npm view failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
      )
    }
    const text = result.stdout.trim()
    // A package with one published version answers with a bare string.
    const parsed = JSON.parse(text.startsWith('[') ? text : JSON.stringify([text]))
    if (!Array.isArray(parsed)) throw new Error('npm view returned an unexpected payload')
    return parsed.filter((entry) => typeof entry === 'string')
  }

  /**
   * Install one exact version globally.
   * @param {string} version - version or range to install.
   * @returns {Promise<{ code: number, stdout: string, stderr: string, installed: string | null }>} result.
   */
  async install(version) {
    await this.ready()
    const spec = `${PACKAGE}@${version}`
    const result = await run('npm', ['install', '-g', spec, ...this.baseArgs()], {
      timeoutMs: 600_000,
      env: this.env,
    })
    // npm may rewrite the prefix, so the cached answer is dropped rather than trusted.
    this.globalRootCache = null
    const installed = result.code === 0 ? await this.installedVersion() : null
    return { ...result, installed }
  }

  /**
   * One metadata field of a published version. A failed lookup answers null:
   * these reads only tighten the upgrade, they must not block one.
   * @param {string} version - exact published version.
   * @param {string} field - `npm view` field name.
   * @returns {Promise<unknown>} parsed value, or null.
   */
  async metadata(version, field) {
    await this.ready()
    const result = await run('npm', ['view', `${PACKAGE}@${version}`, field, '--json', '--silent', ...this.baseArgs()], {
      timeoutMs: 60_000,
      env: this.env,
    })
    if (result.code !== 0) return null
    const text = result.stdout.trim()
    if (text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /**
   * The `engines` a release declares, so an upgrade can refuse a runtime it
   * cannot boot instead of discovering that after the restart.
   * @param {string} version - exact published version.
   * @returns {Promise<object | null>} engines, or null when unknown.
   */
  async enginesOf(version) {
    const value = await this.metadata(version, 'engines')
    return typeof value === 'object' && value !== null ? value : null
  }

  /**
   * The deprecation notice of a release, when there is one.
   * @param {string} version - exact published version.
   * @returns {Promise<string | null>} notice, or null.
   */
  async deprecationOf(version) {
    const value = await this.metadata(version, 'deprecated')
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }

  /**
   * Re-run the image's node-pty repair, when the image ships one. A version bump
   * can replace node-pty with a build that has no prebuilt binary on this
   * platform; the entrypoint script is what fixes that, and it is idempotent.
   * @returns {Promise<string | null>} its output, or null when unavailable.
   */
  async repairNativeModules() {
    const script = '/usr/local/bin/fix-node-pty.sh'
    if (!existsSync(script)) return null
    try {
      const result = await run(script, [], { timeoutMs: 300_000, env: this.env })
      return tail(`${result.stdout}\n${result.stderr}`).trim()
    } catch (error) {
      return `fix-node-pty.sh: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
