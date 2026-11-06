/**
 * Persistent state for the Github component.
 *
 * The token is the only secret, and it is deliberately a separate file: the
 * git credential helper reads it directly, while the panel only ever sees the
 * non-secret metadata in `state.json`. Everything lives under
 * `$DSH_HOME/github/` so the directory can be locked to 0700 and the
 * token to 0600.
 * @module yukari-dsh-plugin/github/store
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Directory under DSH_HOME. */
const DIRECTORY = 'github'

/** The directory an older version used, migrated once on boot. */
export const LEGACY_DIRECTORY = 'yukari-github'

/** File names inside that directory. */
const TOKEN_FILE = 'token'
const META_FILE = 'state.json'
const HELPER_FILE = 'credential'
const INCLUDE_FILE = 'gitconfig'

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Read/write the Github component's files with owner-only permissions.
 */
export class GitHubStore {
  #paths

  /**
   * @param options.home - the resolved DSH_HOME.
   */
  constructor({ home }) {
    const directory = path.join(home, DIRECTORY)
    this.#paths = {
      directory,
      tokenFile: path.join(directory, TOKEN_FILE),
      metaFile: path.join(directory, META_FILE),
      helperFile: path.join(directory, HELPER_FILE),
      includeFile: path.join(directory, INCLUDE_FILE),
      // The entry an older version added to ~/.gitconfig, dropped once its file is gone.
      legacyIncludeFile: path.join(home, LEGACY_DIRECTORY, INCLUDE_FILE),
    }
  }

  /** Absolute paths, exposed for the git installer and the panel. */
  get paths() {
    return this.#paths
  }

  /** Create the directory with owner-only permissions. */
  async ensure() {
    await mkdir(this.#paths.directory, { recursive: true, mode: 0o700 })
    await chmod(this.#paths.directory, 0o700)
  }

  /** The stored token, or null when absent/empty. */
  async readToken() {
    try {
      const text = await readFile(this.#paths.tokenFile, 'utf8')
      const token = text.trim()
      return token === '' ? null : token
    } catch {
      return null
    }
  }

  /** Non-secret metadata; an absent or malformed file reads as `{}`. */
  async readMeta() {
    try {
      const value = JSON.parse(await readFile(this.#paths.metaFile, 'utf8'))
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch {
      return {}
    }
  }

  /** Atomically write the token, owner-only. */
  async writeToken(token) {
    await this.ensure()
    await this.#writeAtomic(this.#paths.tokenFile, token, 0o600)
  }

  /** Atomically write metadata, owner-only. Never pass the token here. */
  async writeMeta(meta) {
    await this.ensure()
    await this.#writeAtomic(this.#paths.metaFile, `${JSON.stringify(meta, null, 2)}\n`, 0o600)
  }

  /** Atomically write the credential helper, owner-only. */
  async writeHelper(script) {
    await this.ensure()
    await this.#writeAtomic(this.#paths.helperFile, script, 0o600)
  }

  /** Atomically write the managed gitconfig include, owner-only. */
  async writeInclude(config) {
    await this.ensure()
    await this.#writeAtomic(this.#paths.includeFile, config, 0o600)
  }

  /** Delete just the token; used first so a failed cleanup still revokes access. */
  async removeToken() {
    await rm(this.#paths.tokenFile, { force: true })
  }

  /** Delete every file this component owns. */
  async clear() {
    await this.removeToken()
    await rm(this.#paths.metaFile, { force: true })
    await rm(this.#paths.helperFile, { force: true })
    await rm(this.#paths.includeFile, { force: true })
    // The directory is shared with nothing else; remove it when it is empty.
    await rm(this.#paths.directory, { recursive: false, force: true }).catch(() => {})
  }

  /**
   * Correct permissions after a restore or an older copy: 0700 for the
   * directory, 0600 for the files. Missing files are fine.
   * @returns the errors that were not just "missing".
   */
  async normalizePermissions() {
    const errors = []
    try {
      await this.ensure()
    } catch (error) {
      errors.push(error)
    }
    const files = [
      [this.#paths.tokenFile, 0o600],
      [this.#paths.metaFile, 0o600],
      [this.#paths.helperFile, 0o600],
      [this.#paths.includeFile, 0o600],
    ]
    for (const [file, mode] of files) {
      try {
        const info = await stat(file)
        if ((info.mode & 0o777) !== mode) await chmod(file, mode)
      } catch (error) {
        if (error?.code !== 'ENOENT') errors.push(error)
      }
    }
    return errors
  }

  /** Write one file through a same-directory temporary and an atomic rename. */
  async #writeAtomic(file, content, mode) {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporary, content, { mode })
      await chmod(temporary, mode)
      await rename(temporary, file)
      await chmod(file, mode)
    } catch (error) {
      throw new Error(`无法写入 ${file}：${messageOf(error)}`)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
}
