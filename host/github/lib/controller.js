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
import { addSigningKey, getLatestCommit, getRepo, getUser, listSigningKeys, parseRepoInput, removeSigningKey } from './api.js'
import { GitCredential, supportsSshSigning } from './git.js'
import { SigningKey, sameKey } from './signing.js'
import { redact } from './redact.js'
import { GitHubStore } from './store.js'
import { appError } from '../../shared/http.js'

export { redact } from './redact.js'

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** Tokens are opaque, but never whitespace and never huge. */
const TOKEN_LIMIT = 1024

/** 登记到 GitHub 的签名密钥标题。 */
const SIGNING_TITLE = 'yukari-dsh-plugin'

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
  if (token === '') throw appError('请填写 GitHub 令牌', 'github-token-empty')
  if (/\s/.test(token) || token.length > TOKEN_LIMIT) throw appError('令牌格式不正确：不能有空白字符，长度也不能超过上限', 'github-token-invalid')
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
  #signing
  #signingError

  /**
   * @param options.home - resolved DSH_HOME; defaults to the process home.
   * @param options.fetchImpl - injectable fetch for tests.
   * @param options.gitCommand - injectable git executable.
   * @param options.sshKeygen - injectable ssh-keygen executable.
   * @param options.env - environment for git commands.
   * @param options.log - diagnostic sink; must never receive the token.
   */
  constructor({
    home = resolveDshHome(),
    fetchImpl = fetch,
    gitCommand = 'git',
    sshKeygen = 'ssh-keygen',
    env = process.env,
    platform = process.platform,
    log = () => {},
  } = {}) {
    this.#store = new GitHubStore({ home })
    this.#git = new GitCredential({ paths: this.#store.paths, gitCommand, env, platform })
    this.#signing = new SigningKey({ paths: this.#store.paths, sshKeygen })
    this.#fetchImpl = fetchImpl
    this.#log = log
    this.#busy = false
    this.#ready = Promise.resolve()
    this.#gitError = null
    this.#signingError = null
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
    let token
    try {
      token = await this.#store.readToken()
    } catch (error) {
      // 读不出来不等于没配置：此刻不能动全机 include，否则另一个实例会失去凭据。
      this.#gitError = messageOf(error)
      this.#log(`could not read the token file: ${this.#gitError}`)
      return
    }
    try {
      const permissionErrors = await this.#store.normalizePermissions()
      for (const error of permissionErrors) this.#log(`could not repair permissions: ${messageOf(error)}`)
      if (token === null) {
        // 没有令牌时也走释放路径：还有别的实例在用时保留它安装的 include。
        await this.#git.release()
        this.#gitError = null
        return
      }
      // The directory rename moved the include file; drop the pointer an older
      // version left in ~/.gitconfig once that file is really gone.
      const legacy = this.#store.paths.legacyIncludeFile
      if (legacy !== this.#store.paths.includeFile && !existsSync(legacy)) {
        await this.#git.removeInclude(legacy)
      }
      // 早期版本只写了签名配置、没写 allowedSignersFile。密钥还在就补上，升级后
      // 本机的 `%G?` 立刻从 N 变成 G，不需要用户再点一次「启用」。
      const key = await this.#signing.read()
      if (key !== null) await this.#signing.writeAllowedSigners(key.publicKey)
      const result = await this.#git.install()
      this.#gitError = result.ok ? null : redact(result.error, token)
      if (!result.ok) this.#log(`could not install git credentials: ${this.#gitError}`)
    } catch (error) {
      this.#gitError = redact(messageOf(error), token)
      this.#log(`initialization failed: ${this.#gitError}`)
    }
  }

  /**
   * Panel state; never contains the token.
   *
   * Reading the token file can fail (permissions, a directory in its place).
   * That is reported as an error instead of an empty state: the panel only
   * shows the failure card when this call fails, and an unreadable token is
   * not the same thing as "not configured".
   */
  async state() {
    await this.#ready
    const token = await this.#store.readToken()
    const meta = await this.#store.readMeta()
    const git = await this.#git.inspect()
    const key = await this.#signing.read()
    const stored = meta.signing !== null && typeof meta.signing === 'object' ? meta.signing : {}
    const storedKeyId = Number.isInteger(stored.keyId) ? stored.keyId : null
    const manualAt = typeof stored.manualAt === 'string' ? stored.manualAt : null
    // 指纹对得上才算登记过：密钥重新生成过，旧的登记 id 就不能再用。手动添加没有
    // 密钥 id（令牌读不到列表），用 manualAt 记下"用户说已经加过了"。
    const registered =
      key !== null &&
      key.fingerprint !== null &&
      stored.fingerprint === key.fingerprint &&
      (storedKeyId !== null || manualAt !== null)
    return {
      configured: token !== null,
      host: 'github.com',
      account: publicAccount(meta.account),
      git: {
        ...git,
        tokenFile: this.#store.paths.tokenFile,
        error: redact(git.error ?? (git.helperInstalled ? null : this.#gitError), token),
      },
      signing: {
        enabled: git.signingEnabled,
        keyFile: this.#store.paths.signingKeyFile,
        publicKey: key?.publicKey ?? null,
        fingerprint: key?.fingerprint ?? null,
        registered,
        manual: registered && storedKeyId === null,
        registeredAt: registered ? (typeof stored.registeredAt === 'string' ? stored.registeredAt : manualAt) : null,
        error: this.#signingError,
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
        const meta = await this.#store.readMeta()
        await this.#store
          .writeMeta({ ...meta, version: 1, account: { ...account, verifiedAt: now }, updatedAt: now })
          .catch((error) => this.#log(`could not save GitHub metadata: ${messageOf(error)}`))
        const result = await this.#git.install()
        this.#gitError = result.ok ? null : redact(result.error, token)
        if (!result.ok) this.#log(`could not install git credentials: ${this.#gitError}`)
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
      if (token === null) throw appError('尚未配置 GitHub 令牌', 'github-token-missing')
      let account
      try {
        account = await getUser(token, { fetchImpl: this.#fetchImpl })
      } catch (error) {
        throw new Error(redact(messageOf(error), token))
      }
      const now = new Date().toISOString()
      const meta = await this.#store.readMeta()
      await this.#store
        .writeMeta({ ...meta, version: 1, account: { ...account, verifiedAt: now }, updatedAt: now })
        .catch((error) => this.#log(`could not save GitHub metadata: ${messageOf(error)}`))
      return this.state()
    })
  }

  /** Check whether the stored token can push to one repository. */
  async checkRepo(raw) {
    return this.#serial(async () => {
      const token = await this.#store.readToken()
      if (token === null) throw appError('尚未配置 GitHub 令牌', 'github-token-missing')
      const parsed = parseRepoInput(raw)
      try {
        const repo = await getRepo(token, parsed.owner, parsed.repo, { fetchImpl: this.#fetchImpl })
        // 签名有没有被 GitHub 认下来，只有 GitHub 自己能回答；附带最近一次提交的结论。
        try {
          const latestCommit = await getLatestCommit(token, parsed.owner, parsed.repo, { fetchImpl: this.#fetchImpl })
          return { ...repo, latestCommit, latestCommitError: null }
        } catch (error) {
          return { ...repo, latestCommit: null, latestCommitError: redact(messageOf(error), token) }
        }
      } catch (error) {
        throw new Error(redact(messageOf(error), token))
      }
    })
  }

  /** Reinstall the helper and include after a manual edit or a bad restore. */
  async install() {
    return this.#serial(async () => {
      const token = await this.#store.readToken()
      if (token === null) throw appError('尚未配置 GitHub 令牌', 'github-token-missing')
      const result = await this.#git.install()
      this.#gitError = result.ok ? null : redact(result.error, token)
      if (!result.ok) throw new Error(this.#gitError)
      return this.state()
    })
  }

  /**
   * 启用提交签名：生成密钥、登记到 GitHub、写进 git 的 include。
   *
   * 登记失败（多半是令牌缺少 `admin:ssh_signing_key` 权限）不算整体失败：密钥已经
   * 生成、本机照样能签，面板给出公钥和手动添加的入口。真失败只报真正失败的那一步。
   */
  async enableSigning() {
    return this.#serial(async () => {
      const token = await this.#store.readToken()
      if (token === null) throw appError('尚未配置 GitHub 令牌', 'github-token-missing')
      const git = await this.#git.inspect()
      if (!git.available) throw appError('未找到 git，无法配置提交签名', 'github-git-missing')
      if (!supportsSshSigning(git.version)) {
        throw appError(`当前 git ${git.version ?? ''} 不支持 SSH 提交签名，需要 2.34 或更高版本`, 'github-git-old')
      }
      // 用户自己的全局签名配置不会被 include 覆盖时，静默写进去只会让"已启用"变成谎话。
      const current = await this.#git.signingConfig()
      if (current.format !== '' && current.format !== 'ssh') {
        throw appError(`全局 git 已配置 gpg.format = ${current.format}，请先取消原有签名配置再启用提交签名。`, 'github-signing-conflict')
      }
      if (current.signingKey !== '' && current.signingKey !== this.#store.paths.signingPublicKeyFile) {
        throw appError(`全局 git 已配置 user.signingkey = ${current.signingKey}，请先取消原有签名配置再启用提交签名。`, 'github-signing-conflict')
      }
      const key = await this.#signing.generate()
      if (key === null) throw new Error('生成签名密钥失败：没有读到公钥')
      await this.#signing.writeAllowedSigners(key.publicKey)
      const problems = []
      let keyId = null
      try {
        keyId = await this.#registerKey(token, key)
      } catch (failure) {
        problems.push(redact(messageOf(failure), token))
      }
      const meta = await this.#store.readMeta()
      await this.#store.writeMeta({
        ...meta,
        version: 1,
        signing: {
          fingerprint: key.fingerprint,
          keyId,
          registeredAt: keyId === null ? null : new Date().toISOString(),
          manualAt: null,
        },
      })
      const result = await this.#git.install()
      this.#gitError = result.ok ? null : redact(result.error, token)
      if (!result.ok) this.#log(`could not install git credentials: ${this.#gitError}`)
      if (result.ok && !(await this.#git.inspect()).signingEnabled) {
        problems.push('提交签名配置被全局 git 配置覆盖，未生效；请检查 ~/.gitconfig 中的 gpg.format、commit.gpgsign 与 user.signingkey。')
      }
      this.#signingError = problems.length === 0 ? null : problems.join(' ')
      if (this.#signingError !== null) this.#log(`commit signing is incomplete: ${this.#signingError}`)
      return this.state()
    })
  }

  /**
   * 关闭提交签名：注销 GitHub 上的密钥、删除本机密钥、从 include 里去掉签名配置。
   *
   * 注销失败仍会关掉本机签名，但私钥也会删掉；残留的公开密钥在账号上已没有对应用
   * 的私钥，面板把原因报出来，让人能去 GitHub 上手动删。
   */
  async disableSigning() {
    return this.#serial(async () => {
      const token = await this.#store.readToken().catch(() => null)
      const meta = await this.#store.readMeta()
      const keyId = Number.isInteger(meta.signing?.keyId) ? meta.signing.keyId : null
      let error = null
      if (keyId !== null) {
        if (token === null) {
          error = '尚未配置 GitHub 令牌，未能删除账号上的签名密钥。'
        } else {
          try {
            await removeSigningKey(token, keyId, { fetchImpl: this.#fetchImpl })
          } catch (failure) {
            error = redact(`未能删除 GitHub 上的签名密钥：${messageOf(failure)}`, token)
          }
        }
      }
      await this.#signing.remove()
      this.#signingError = error
      if (error !== null) this.#log(`could not finish disabling commit signing: ${error}`)
      await this.#store.writeMeta({ ...meta, version: 1, signing: { fingerprint: null, keyId: null, registeredAt: null, manualAt: null } })
      const result = await this.#git.install()
      this.#gitError = result.ok ? null : redact(result.error, token)
      if (!result.ok) this.#log(`could not install git credentials: ${this.#gitError}`)
      return this.state()
    })
  }

  /**
   * 用户把公钥手动添加到 GitHub 之后，把这件事记下来。
   *
   * 只用于令牌读不到 `ssh_signing_keys` 的情况：这时插件没法自己核对，但公钥确实
   * 已经在账号上，状态不能一直显示「未登记」。结论仍然以 GitHub 对提交的
   * `verification` 为准，这里只是不让面板说反话。
   */
  async markSigningManual() {
    return this.#serial(async () => {
      const key = await this.#signing.read()
      if (key === null) throw appError('尚未生成签名密钥，无法登记', 'github-signing-missing')
      const meta = await this.#store.readMeta()
      const stored = meta.signing !== null && typeof meta.signing === 'object' ? meta.signing : {}
      await this.#store.writeMeta({
        ...meta,
        version: 1,
        signing: {
          fingerprint: key.fingerprint,
          keyId: Number.isInteger(stored.keyId) ? stored.keyId : null,
          registeredAt: typeof stored.registeredAt === 'string' ? stored.registeredAt : null,
          manualAt: new Date().toISOString(),
        },
      })
      this.#signingError = null
      return this.state()
    })
  }

  /** Revoke: delete the token first, then remove the include and files. */
  async clear() {
    return this.#serial(async () => {
      const token = await this.#store.readToken().catch(() => null)
      const meta = await this.#store.readMeta()
      const keyId = Number.isInteger(meta.signing?.keyId) ? meta.signing.keyId : null
      if (keyId !== null && token !== null) {
        try {
          await removeSigningKey(token, keyId, { fetchImpl: this.#fetchImpl })
        } catch (failure) {
          // 令牌马上就删了，注销失败只能记日志；私钥随目录一起删掉。
          this.#log(`could not remove the GitHub signing key: ${redact(messageOf(failure), token)}`)
        }
      }
      await this.#store.clear()
      try {
        await this.#git.uninstall()
        this.#gitError = null
      } catch (error) {
        this.#gitError = redact(messageOf(error), token)
        this.#log(`could not remove git credentials: ${this.#gitError}`)
      }
      return this.state()
    })
  }

  /**
   * Stop the component; the token file stays for the next start.
   *
   * Only the last live holder removes the shared include: another controller
   * (or another process on the same DSH_HOME) may still be pushing with it.
   */
  async dispose() {
    try {
      await this.#git.release()
    } catch (error) {
      this.#log(`could not release git credentials: ${messageOf(error)}`)
    }
  }

  /** 按公钥找账号上的签名密钥，没有就登记一把。 */
  async #registerKey(token, key) {
    const keys = await listSigningKeys(token, { fetchImpl: this.#fetchImpl })
    const existing = keys.find((item) => sameKey(item.key, key.publicKey))
    if (existing !== undefined) return existing.id
    const created = await addSigningKey(token, { title: SIGNING_TITLE, key: key.publicKey }, { fetchImpl: this.#fetchImpl })
    return created.id
  }

  /** Serialize mutating actions so a double click cannot race the token file. */
  async #serial(action) {
    await this.#ready
    if (this.#busy) throw appError('另一个 GitHub 操作正在进行', 'github-busy')
    this.#busy = true
    try {
      return await action()
    } finally {
      this.#busy = false
    }
  }
}
