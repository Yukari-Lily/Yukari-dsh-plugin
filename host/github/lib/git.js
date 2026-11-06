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
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

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
 * @param options.helperFile - absolute helper path.
 * @returns the config text.
 */
export function buildGitConfig({ helperFile }) {
  return `# Managed by yukari-dsh-plugin — do not edit.
[credential "https://github.com"]
\thelper = ""
\thelper = ${gitConfigQuote(`!sh ${shellQuote(helperFile)}`)}
\tusername = x-access-token
`
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
      return {
        available: true,
        version,
        helperInstalled: includes.includes(this.#paths.includeFile) && helper,
        includePath: this.#paths.includeFile,
        error: null,
      }
    } catch (error) {
      return {
        available: false,
        version: null,
        helperInstalled: false,
        includePath: this.#paths.includeFile,
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
      await this.#write(this.#paths.helperFile, buildHelperScript(this.#paths.tokenFile), 0o600)
      await this.#write(this.#paths.includeFile, buildGitConfig({ helperFile: this.#paths.helperFile }), 0o600)
      await this.#addInclude()
      const includes = await this.#includes()
      if (!includes.includes(this.#paths.includeFile)) {
        return { ok: false, error: 'git 没有接受 include.path，请检查 ~/.gitconfig 是否可写。' }
      }
      if (!(await this.#exists(this.#paths.helperFile))) {
        return { ok: false, error: 'git 凭据助手文件没有写成功。' }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /** Remove the global include and the files this installer owns. */
  async uninstall() {
    let failure = null
    try {
      await this.#removeInclude()
    } catch (error) {
      failure = error
    }
    await rm(this.#paths.includeFile, { force: true })
    await rm(this.#paths.helperFile, { force: true })
    if (failure !== null) throw failure
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
    try {
      await this.#run(['config', '--global', '--fixed-value', '--unset-all', 'include.path', this.#paths.includeFile])
      return
    } catch (error) {
      const code = Number(error?.code)
      if (code === 1 || code === 5) return
      const stderr = String(error?.stderr ?? '')
      // Older git has no --fixed-value. Fall back to an anchored exact regex;
      // the include path is plugin-owned, so this cannot remove user entries.
      if (/fixed-value|unknown option/i.test(stderr) || code === 129) {
        const pattern = this.#paths.includeFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        await this.#allow(['config', '--global', '--unset-all', 'include.path', `^${pattern}$`], [1, 5])
        return
      }
      throw error
    }
  }

  /** Write one owner-only file, creating the directory if needed. */
  async #write(file, content, mode) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await chmod(path.dirname(file), 0o700)
    await writeFile(file, content, { mode })
    await chmod(file, mode)
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
