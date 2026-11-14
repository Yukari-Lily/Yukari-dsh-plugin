/**
 * SSH commit signing keys for the Github component.
 *
 * GitHub 只有在提交带签名、且签名密钥登记在账号上时才显示 Verified。这里生成一把
 * 只用于签名的 ed25519 密钥：私钥 0600 放在 `$DSH_HOME/github/signing/`，公钥路径写进
 * 组件管理的 include，公钥本身交给控制器登记到 GitHub。私钥不出本机，也不进任何
 * 配置文件。
 * @module yukari-dsh-plugin/github/signing
 */
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { writeFileAtomic } from './atomic.js'

const execFileAsync = promisify(execFile)

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** 密钥注释；它会出现在 GitHub 的签名密钥列表里。 */
const KEY_COMMENT = 'yukari-dsh-plugin'

/** 一把本机签名密钥。 */
export class SigningKey {
  #paths
  #sshKeygen
  #timeoutMs

  /**
   * @param options.paths - the store's absolute paths.
   * @param options.sshKeygen - executable used to create and inspect keys.
   * @param options.timeoutMs - per-command timeout.
   */
  constructor({ paths, sshKeygen = 'ssh-keygen', timeoutMs = 15000 }) {
    this.#paths = paths
    this.#sshKeygen = sshKeygen
    this.#timeoutMs = timeoutMs
  }

  /** Absolute paths, for the panel state. */
  get paths() {
    return this.#paths
  }

  /**
   * 现有密钥：公钥文本与指纹。没有密钥文件时为 null。
   * @returns `{ publicKey, fingerprint }`；指纹读不出来时为 null。
   */
  async read() {
    let publicKey
    try {
      publicKey = (await readFile(this.#paths.signingPublicKeyFile, 'utf8')).trim()
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw new Error(`无法读取签名公钥 ${this.#paths.signingPublicKeyFile}：${messageOf(error)}`)
    }
    if (publicKey === '') return null
    return { publicKey, fingerprint: await this.#fingerprint() }
  }

  /** 生成密钥对；已有公钥时直接返回它，不覆盖。 */
  async generate() {
    const existing = await this.read()
    if (existing !== null) return existing
    await mkdir(this.#paths.signingDirectory, { recursive: true, mode: 0o700 })
    await chmod(this.#paths.signingDirectory, 0o700)
    try {
      await execFileAsync(
        this.#sshKeygen,
        ['-q', '-t', 'ed25519', '-N', '', '-C', KEY_COMMENT, '-f', this.#paths.signingKeyFile],
        { timeout: this.#timeoutMs, windowsHide: true },
      )
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('未找到 ssh-keygen，无法生成提交签名密钥')
      throw new Error(`生成签名密钥失败：${messageOf(error)}`)
    }
    // ssh-keygen 按 umask 落盘；私钥只留给当前用户，公钥待在共享目录里也无妨。
    await chmod(this.#paths.signingKeyFile, 0o600)
    await chmod(this.#paths.signingPublicKeyFile, 0o600)
    return this.read()
  }

  /**
   * 写 `gpg.ssh.allowedSignersFile`。
   *
   * 没有这个文件，`git verify-commit` / `git log --format=%G?` 在本地会直接报错或
   * 显示 N，看起来像没签名。`*` 作主体表示不限定邮箱，只核对密钥本身。
   * @param publicKey - 公钥文本。
   */
  async writeAllowedSigners(publicKey) {
    await writeFileAtomic(this.#paths.signingAllowedSignersFile, `* ${publicKey}\n`, 0o600)
  }

  /** 删除本机密钥。 */
  async remove() {
    await rm(this.#paths.signingKeyFile, { force: true })
    await rm(this.#paths.signingPublicKeyFile, { force: true })
    await rm(this.#paths.signingAllowedSignersFile, { force: true })
  }

  /** `ssh-keygen -l` 给出的 SHA256 指纹；失败只返回 null。 */
  async #fingerprint() {
    try {
      const { stdout } = await execFileAsync(this.#sshKeygen, ['-l', '-f', this.#paths.signingPublicKeyFile], {
        timeout: this.#timeoutMs,
        windowsHide: true,
      })
      return /SHA256:[A-Za-z0-9+/=]+/.exec(stdout)?.[0] ?? null
    } catch {
      return null
    }
  }
}

/**
 * 比较两把公钥。GitHub 回显的 key 可能带注释，只比对算法与密钥本体。
 * @param a - 公钥文本。
 * @param b - 公钥文本。
 */
export function sameKey(a, b) {
  const fields = (value) => String(value ?? '').trim().split(/\s+/).slice(0, 2).join(' ')
  const left = fields(a)
  return left !== '' && left === fields(b)
}
