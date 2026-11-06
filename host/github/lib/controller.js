/**
 * The Github component's controller.
 *
 * It owns the token file, the git include and the panel-facing state. The
 * token is only written to its 0600 file; the controller reads it when it has
 * to call GitHub or install the helper, and never returns it.
 * @module yukari-dsh-plugin/github/controller
 */
import { existsSync } from 'node:fs'
import { resolveDshHome } from '../../shared/home.js'
import { getRepo, getUser, parseRepoInput } from './api.js'
import { GitCredential } from './git.js'
import { GitHubStore } from './store.js'

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** Tokens are opaque, but never whitespace and never huge. */
const TOKEN_LIMIT = 1024

/** Replace every occurrence of the secret in a message. */
export function redact(text, token) {
  const value = String(text ?? '')
  if (typeof token !== 'string' || token === '') return value
  const encoded = encodeURIComponent(token)
  return value.split(token).join('***').split(encoded).join('***')
}

/** Keep only the account fields the panel may see. */
function publicAccount(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const login = typeof raw.login === 'string' ? raw.login : ''
  if (login === '') return null
  return {
    login,
    name: typeof raw.name === 'string' ? raw.name : '',
    avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : '',
    htmlUrl: typeof raw.htmlUrl === 'string' ? raw.htmlUrl : '',
    tokenType: ['classic', 'fine-grained', 'unknown'].includes(raw.tokenType) ? raw.tokenType : 'unknown',
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((scope) => typeof scope === 'string') : [],
    expiresAt: typeof raw.expiresAt === 'string' && raw.expiresAt !== '' ? raw.expiresAt : null,
    expired: raw.expired === true,
    verifiedAt: typeof raw.verifiedAt === 'string' ? raw.verifiedAt : null,
  }
}

/** Validate and normalize the pasted token. */
function normalizeToken(raw) {
  const token = String(raw ?? '').trim()
  if (token === '') throw new Error('请粘贴 GitHub 令牌')
  if (/\s/.test(token)) throw new Error('令牌里不能有空白字符')
  if (token.length > TOKEN_LIMIT) throw new Error('令牌长度不合法')
  return token
}

/** The controller behind the panel's HTTP routes. */
export class GitHubController {
  #store
  #git
  #fetchImpl
  #log
  #busy
  #ready
  #gitError

  /**
   * @param options.home - resolved DSH_HOME; defaults to the process home.
   * @param options.fetchImpl - injectable fetch for tests.
   * @param options.gitCommand - injectable git executable.
   * @param options.env - environment for git commands.
   * @param options.log - diagnostic sink; must never receive the token.
   */
  constructor({
    home = resolveDshHome(),
    fetchImpl = fetch,
    gitCommand = 'git',
    env = process.env,
    platform = process.platform,
    log = () => {},
  } = {}) {
    this.#store = new GitHubStore({ home })
    this.#git = new GitCredential({ paths: this.#store.paths, gitCommand, env, platform })
    this.#fetchImpl = fetchImpl
    this.#log = log
    this.#busy = false
    this.#ready = Promise.resolve()
    this.#gitError = null
  }

  /** Paths the panel may display (no token). */
  get paths() {
    return this.#store.paths
  }

  /** Read the persisted token, repair permissions, and reinstall the helper. */
  async init() {
    this.#ready = this.#initialize()
    return this.#ready
  }

  /** The initial pass, kept separate so `init()` can expose one promise. */
  async #initialize() {
    try {
      const token = await this.#store.readToken()
      const permissionErrors = await this.#store.normalizePermissions()
      for (const error of permissionErrors) this.#log(`could not repair permissions: ${messageOf(error)}`)
      if (token === null) {
        await this.#git.uninstall()
        this.#gitError = null
        return
      }
      // The directory rename moved the include file; drop the pointer an older
      // version left in ~/.gitconfig once that file is really gone.
      const legacy = this.#store.paths.legacyIncludeFile
      if (legacy !== this.#store.paths.includeFile && !existsSync(legacy)) {
        await this.#git.removeInclude(legacy)
      }
      const result = await this.#git.install()
      this.#gitError = result.ok ? null : result.error
      if (!result.ok) this.#log(`could not install git credentials: ${result.error}`)
    } catch (error) {
      this.#gitError = messageOf(error)
      this.#log(`initialization failed: ${this.#gitError}`)
    }
  }

  /** Panel state; never contains the token. */
  async state() {
    await this.#ready
    const token = await this.#store.readToken()
    const meta = await this.#store.readMeta()
    const git = await this.#git.inspect()
    return {
      configured: token !== null,
      host: 'github.com',
      account: publicAccount(meta.account),
      git: {
        ...git,
        tokenFile: this.#store.paths.tokenFile,
        error: git.error ?? (git.helperInstalled ? null : this.#gitError),
      },
      updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : null,
    }
  }

  /** Validate a token, persist it, and install the helper. */
  async saveToken(raw) {
    return this.#serial(async () => {
      const token = normalizeToken(raw)
      let account
      try {
        account = await getUser(token, { fetchImpl: this.#fetchImpl })
      } catch (error) {
        throw new Error(redact(messageOf(error), token))
      }
      const now = new Date().toISOString()
      try {
        await this.#store.writeToken(token)
        await this.#store
          .writeMeta({ version: 1, account: { ...account, verifiedAt: now }, updatedAt: now })
          .catch((error) => this.#log(`could not save GitHub metadata: ${messageOf(error)}`))
        const result = await this.#git.install()
        this.#gitError = result.ok ? null : result.error
        if (!result.ok) this.#log(`could not install git credentials: ${result.error}`)
      } catch (error) {
        throw new Error(redact(messageOf(error), token))
      }
      return this.state()
    })
  }

  /** Re-read the GitHub account with the stored token. */
  async verify() {
    return this.#serial(async () => {
      const token = await this.#store.readToken()
      if (token === null) throw new Error('尚未配置 GitHub 令牌')
      let account
      try {
        account = await getUser(token, { fetchImpl: this.#fetchImpl })
      } catch (error) {
        throw new Error(redact(messageOf(error), token))
      }
      const now = new Date().toISOString()
      await this.#store
        .writeMeta({ version: 1, account: { ...account, verifiedAt: now }, updatedAt: now })
        .catch((error) => this.#log(`could not save GitHub metadata: ${messageOf(error)}`))
      return this.state()
    })
  }

  /** Check whether the stored token can push to one repository. */
  async checkRepo(raw) {
    return this.#serial(async () => {
      const token = await this.#store.readToken()
      if (token === null) throw new Error('尚未配置 GitHub 令牌')
      const parsed = parseRepoInput(raw)
      try {
        return await getRepo(token, parsed.owner, parsed.repo, { fetchImpl: this.#fetchImpl })
      } catch (error) {
        throw new Error(redact(messageOf(error), token))
      }
    })
  }

  /** Reinstall the helper and include after a manual edit or a bad restore. */
  async install() {
    return this.#serial(async () => {
      const token = await this.#store.readToken()
      if (token === null) throw new Error('尚未配置 GitHub 令牌')
      const result = await this.#git.install()
      this.#gitError = result.ok ? null : result.error
      if (!result.ok) throw new Error(result.error)
      return this.state()
    })
  }

  /** Revoke: delete the token first, then remove the include and files. */
  async clear() {
    return this.#serial(async () => {
      await this.#store.clear()
      try {
        await this.#git.uninstall()
        this.#gitError = null
      } catch (error) {
        this.#gitError = messageOf(error)
        this.#log(`could not remove git credentials: ${this.#gitError}`)
      }
      return this.state()
    })
  }

  /** Stop the component; the token file stays for the next start. */
  async dispose() {
    try {
      await this.#git.uninstall()
    } catch (error) {
      this.#log(`could not remove git credentials: ${messageOf(error)}`)
    }
  }

  /** Serialize mutating actions so a double click cannot race the token file. */
  async #serial(action) {
    await this.#ready
    if (this.#busy) throw new Error('另一个 Github 操作正在进行')
    this.#busy = true
    try {
      return await action()
    } finally {
      this.#busy = false
    }
  }
}
