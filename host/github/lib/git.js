/**
 * Git credential plumbing for the Github component.
 *
 * The token never enters a git config value or an environment variable: this
 * module writes a tiny helper that reads the 0600 token file and answers one
 * `get` request at a time. The helper is only reachable through the
 * `credential.https://github.com` subsection installed in the managed include,
 * and it re-checks the request's protocol and host before printing anything.
 * @module yukari-dsh-plugin/github/git
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { writeFileAtomic } from './atomic.js'

const execFileAsync = promisify(execFile)

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** 进程是否还活着；EPERM 说明进程存在，只是不属于当前用户。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Quote one value for a POSIX shell, including embedded single quotes. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** Escape one value for a double-quoted git config string. */
function gitConfigQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * The helper script. It contains the token file path, never the token.
 * @param tokenFile - absolute token path.
 * @returns the script text.
 */
export function buildHelperScript(tokenFile) {
  return `#!/bin/sh
# Managed by yukari-dsh-plugin. Reads the GitHub token from a 0600 file.
op=$1
protocol=
host=
while IFS= read -r line; do
  case "$line" in
    protocol=*) protocol=\${line#protocol=} ;;
    host=*) host=\${line#host=} ;;
  esac
done
[ "$op" = "get" ] || exit 0
[ "$protocol" = "https" ] || exit 0
case "$host" in
  github.com|github.com:443) ;;
  *) exit 0 ;;
esac
token=$(cat ${shellQuote(tokenFile)} 2>/dev/null) || exit 0
[ -n "$token" ] || exit 0
printf 'username=x-access-token\\npassword=%s\\n' "$token"
`
}

/**
 * The managed include. The empty helper line resets any helper installed for
 * github.com earlier in the global config; ours follows and is scoped to that
 * host only.
 *
 * 提交签名只写公钥路径：`gpg.format=ssh` 让 git 用 ssh-keygen 签，`commit.gpgsign`
 * 让每次提交都签。私钥留在 `$DSH_HOME/github/signing/`，这里不出现。
 * @param options.helperFile - absolute helper path.
 * @param options.signingKeyFile - absolute public key path; omit to leave signing off.
 * @param options.allowedSignersFile - absolute `gpg.ssh.allowedSignersFile` path.
 * @returns the config text.
 */
export function buildGitConfig({ helperFile, signingKeyFile = null, allowedSignersFile = null }) {
  const signing = signingKeyFile === null
    ? ''
    : `
[user]
\tsigningkey = ${gitConfigQuote(signingKeyFile)}
[gpg]
\tformat = ssh
[commit]
\tgpgsign = true
${allowedSignersFile === null ? '' : `[gpg "ssh"]\n\tallowedSignersFile = ${gitConfigQuote(allowedSignersFile)}\n`}`
  return `# Managed by yukari-dsh-plugin — do not edit.
[credential "https://github.com"]
\thelper = ""
\thelper = ${gitConfigQuote(`!sh ${shellQuote(helperFile)}`)}
\tusername = x-access-token
${signing}`
}

/**
 * Whether a `git version` string can sign commits over SSH.
 * @param version - version as reported by `git --version`.
 */
export function supportsSshSigning(version) {
  const match = /^(\d+)\.(\d+)/.exec(String(version ?? ''))
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 2 || (major === 2 && minor >= 34)
}

/**
 * Install, inspect and remove the global git include that points at the
 * managed helper.
 */
export class GitCredential {
  #paths
  #gitCommand
  #env
  #platform
  #timeoutMs
  #holderFile

  /**
   * @param options.paths - the store's absolute paths.
   * @param options.gitCommand - executable used for git.
   * @param options.env - environment for git commands.
   * @param options.platform - process platform, injectable for tests.
   */
  constructor({ paths, gitCommand = 'git', env = process.env, platform = process.platform, timeoutMs = 15000 }) {
    this.#paths = paths
    this.#gitCommand = gitCommand
    this.#env = env
    this.#platform = platform
    this.#timeoutMs = timeoutMs
    this.#holderFile = null
  }

  /** Absolute paths the installer uses. */
  get paths() {
    return this.#paths
  }

  /** Current git and include state; never throws. */
  async inspect() {
    try {
      const { stdout } = await this.#run(['--version'])
      const version = /git version (\S+)/.exec(stdout)?.[1] ?? stdout.trim()
      const includes = await this.#includes()
      const helper = await this.#exists(this.#paths.helperFile)
      const key = await this.#exists(this.#paths.signingPublicKeyFile)
      const signing = await this.signingConfig()
      return {
        available: true,
        version,
        helperInstalled: includes.includes(this.#paths.includeFile) && helper,
        includePath: this.#paths.includeFile,
        // 真正生效的签名配置才算启用：用户自己的 ~/.gitconfig 可能把 include 里的
        // gpg.format / commit.gpgsign / user.signingkey 覆盖掉。
        signingEnabled:
          key &&
          includes.includes(this.#paths.includeFile) &&
          signing.format === 'ssh' &&
          signing.commitGpgsign === 'true' &&
          signing.signingKey === this.#paths.signingPublicKeyFile,
        identity: await this.#identity(),
        error: null,
      }
    } catch (error) {
      return {
        available: false,
        version: null,
        helperInstalled: false,
        includePath: this.#paths.includeFile,
        signingEnabled: false,
        identity: { name: '', email: '' },
        error: messageOf(error),
      }
    }
  }

  /**
   * Write the helper and include, then add the include to the global config.
   * @returns `{ ok: true }` or `{ ok: false, error }`.
   */
  async install() {
    if (this.#platform === 'win32') {
      return { ok: false, error: 'Windows 暂不支持自动安装 git 凭据助手；请在 Git Bash 里手动配置 include.path。' }
    }
    if (this.#paths.helperFile.includes('\n') || this.#paths.tokenFile.includes('\n')) {
      return { ok: false, error: 'DSH_HOME 路径里不能有换行。' }
    }
    try {
      // 登记要在 include 生效前完成：别的实例看到登记就不会在我们还在用时摘掉它。
      await this.#takeHolder()
      await writeFileAtomic(this.#paths.helperFile, buildHelperScript(this.#paths.tokenFile), 0o600)
      const signingKeyFile = (await this.#exists(this.#paths.signingPublicKeyFile)) ? this.#paths.signingPublicKeyFile : null
      const allowedSignersFile = (await this.#exists(this.#paths.signingAllowedSignersFile)) ? this.#paths.signingAllowedSignersFile : null
      await writeFileAtomic(this.#paths.includeFile, buildGitConfig({ helperFile: this.#paths.helperFile, signingKeyFile, allowedSignersFile }), 0o600)
      await this.#addInclude()
      const includes = await this.#includes()
      if (!includes.includes(this.#paths.includeFile)) {
        return { ok: false, error: 'git 未接受 include.path，请检查 ~/.gitconfig 是否可写。' }
      }
      if (!(await this.#exists(this.#paths.helperFile))) {
        return { ok: false, error: 'git 凭据助手文件写入失败。' }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * Give up this instance's claim on the include.
   *
   * The include, the helper and the token path are shared by every controller
   * and process on the same DSH_HOME, so unloading one component must not
   * revoke credentials another one is still using. Only the last live holder
   * removes the global include; the check also reaps entries left behind by a
   * process that died without disposing.
   */
  async release() {
    await this.#dropHolder()
    if (await this.#holdersRemain()) return
    await this.uninstall()
  }

  /** Remove the global include and the files this installer owns. */
  async uninstall() {
    // 先摘 include 再删文件：摘失败时保留 helper，否则配置会指向一个已删文件。
    await this.#removeInclude()
    await rm(this.#paths.includeFile, { force: true })
    await rm(this.#paths.helperFile, { force: true })
  }

  /** Run one git command with the configured environment. */
  async #run(args, { timeout = this.#timeoutMs } = {}) {
    return execFileAsync(this.#gitCommand, args, {
      env: this.#env,
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
  }

  /** Run a git command and treat the listed exit codes as "no result". */
  async #allow(args, codes = [1, 5]) {
    try {
      return await this.#run(args)
    } catch (error) {
      if (codes.includes(Number(error?.code))) return { stdout: '', stderr: String(error?.stderr ?? '') }
      throw error
    }
  }

  /**
   * 全局生效的签名配置，包含组件自己的 include。
   *
   * `--global` 本身不展开 include.path，必须带 `--includes`；否则这里读到的永远
   * 是"没配置"。
   * @returns `{ format, signingKey, commitGpgsign }`。
   */
  async signingConfig() {
    const [format, signingKey, commitGpgsign] = await Promise.all([
      this.#globalGet('gpg.format'),
      this.#globalGet('user.signingkey'),
      this.#globalGet('commit.gpgsign'),
    ])
    return { format, signingKey, commitGpgsign }
  }

  /** 读一个全局配置项；没有配置时是空字符串。 */
  async #globalGet(key) {
    const { stdout } = await this.#allow(['config', '--global', '--includes', '--get', key], [1])
    return stdout.trim()
  }

  /** 全局提交身份；仓库自己的配置会覆盖它，这里只用于在面板上核对邮箱。 */
  async #identity() {
    const [name, email] = await Promise.all([this.#globalGet('user.name'), this.#globalGet('user.email')])
    return { name, email }
  }

  /** Every `include.path` value in the global config. */
  async #includes() {
    const { stdout } = await this.#allow(['config', '--global', '--get-all', 'include.path'], [1])
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  }

  /** Add our include once. */
  async #addInclude() {
    const includes = await this.#includes()
    if (includes.includes(this.#paths.includeFile)) return
    await this.#run(['config', '--global', '--add', 'include.path', this.#paths.includeFile])
  }

  /** Remove every include entry that points at our managed file. */
  async #removeInclude() {
    return this.removeInclude(this.#paths.includeFile)
  }

  /**
   * Remove include entries pointing at one file, whoever owns it.
   * Used to drop the entry an older version left behind when its directory moved.
   * @param file - absolute include path to drop.
   */
  async removeInclude(file) {
    try {
      await this.#run(['config', '--global', '--fixed-value', '--unset-all', 'include.path', file])
      return
    } catch (error) {
      const code = Number(error?.code)
      if (code === 1 || code === 5) return
      const stderr = String(error?.stderr ?? '')
      // Older git has no --fixed-value. Fall back to an anchored exact regex;
      // the include path is plugin-owned, so this cannot remove user entries.
      if (/fixed-value|unknown option/i.test(stderr) || code === 129) {
        const pattern = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        await this.#allow(['config', '--global', '--unset-all', 'include.path', `^${pattern}$`], [1, 5])
        return
      }
      throw error
    }
  }

  /**
   * Register this instance as an include holder.
   *
   * One file per instance keeps concurrent installs from rewriting each
   * other's entry; the pid inside lets another process tell a live holder
   * from a leftover entry.
   */
  async #takeHolder() {
    const directory = this.#paths.holdersDirectory
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    this.#holderFile ??= path.join(directory, `${process.pid}-${randomUUID()}`)
    await writeFile(this.#holderFile, `${process.pid}\n`, { mode: 0o600 })
  }

  /** Remove this instance's holder entry, if it has one. */
  async #dropHolder() {
    if (this.#holderFile === null) return
    const file = this.#holderFile
    this.#holderFile = null
    await rm(file, { force: true })
  }

  /**
   * Whether another live holder remains; dead entries are removed on the way.
   */
  async #holdersRemain() {
    let names
    try {
      names = await readdir(this.#paths.holdersDirectory)
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
    let alive = false
    for (const name of names) {
      const file = path.join(this.#paths.holdersDirectory, name)
      const pid = Number.parseInt((await readFile(file, 'utf8').catch(() => '')).trim(), 10)
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
        alive = true
        continue
      }
      await rm(file, { force: true }).catch(() => {})
    }
    return alive
  }

  /** Whether a regular file exists. */
  async #exists(file) {
    try {
      await stat(file)
      return true
    } catch {
      return false
    }
  }
}
