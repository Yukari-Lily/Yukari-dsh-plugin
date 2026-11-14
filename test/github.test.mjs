import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { USER_AGENT, getUser, parseRepoInput } from '../host/github/lib/api.js'
import { GitHubController, redact } from '../host/github/lib/controller.js'
import { apply } from '../host/github/index.js'
import { GitCredential, buildGitConfig, buildHelperScript, shellQuote, supportsSshSigning } from '../host/github/lib/git.js'
import { SigningKey } from '../host/github/lib/signing.js'
import { GitHubStore } from '../host/github/lib/store.js'

const TOKEN = 'test-token-abcdef'
const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** 凭据用例必须真跑 git；缺 git 时明确写出原因，并由下方用例直接失败。 */
const needsGit = hasGit ? false : '未找到 git 命令：该用例需要真实 git 才能验证凭据助手。'

/** 签名用例要真生成密钥并真跑 git。 */
const hasSshKeygen = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined
const needsSshKeygen = hasSshKeygen ? false : '未找到 ssh-keygen：该用例需要真实密钥才能验证签名。'

/** A temporary DSH_HOME and a temporary git HOME; the prefix includes a space. */
async function fixture(t, { homeIsFile = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yukari github test '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'dsh home')
  await mkdir(home, { recursive: true })
  const gitHome = path.join(root, 'git home')
  if (homeIsFile) await writeFile(gitHome, '')
  else await mkdir(gitHome, { recursive: true })
  const env = {
    ...process.env,
    HOME: gitHome,
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
  }
  delete env.GIT_CONFIG_GLOBAL
  return { root, home, gitHome, env }
}

/** Run a command with stdin, resolving instead of rejecting on a non-zero exit. */
function run(command, args, { env, input, cwd } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { env, timeout: 15000, cwd }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    if (input !== undefined) child.stdin.end(input)
  })
}

/** `git credential fill` against one host. */
async function fill(env, host = 'github.com') {
  return run('git', ['credential', 'fill'], {
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    input: `protocol=https\nhost=${host}\n\n`,
  })
}

/** Every `include.path` entry in the temporary global config. */
async function includes(env) {
  const result = await run('git', ['config', '--global', '--get-all', 'include.path'], { env })
  if (result.error !== null && result.error.code !== 1) throw result.error
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** A fake `/user` response. */
function userFetch({ scopes = 'repo', login = 'octocat', expiresAt = null } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (scopes !== null) headers['x-oauth-scopes'] = scopes
  if (expiresAt !== null) headers['github-authentication-token-expiration'] = expiresAt
  return async () =>
    new Response(JSON.stringify({ login, name: 'The Octocat', avatar_url: 'https://example.test/a.png', html_url: 'https://github.com/octocat' }), {
      status: 200,
      headers,
    })
}

test('parseRepoInput: owner/repo, HTTPS, scp and rejections', () => {
  assert.deepEqual(parseRepoInput('owner/repo'), { owner: 'owner', repo: 'repo' })
  assert.deepEqual(parseRepoInput('owner/repo.git'), { owner: 'owner', repo: 'repo' })
  assert.deepEqual(parseRepoInput('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' })
  assert.deepEqual(parseRepoInput('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo' })
  assert.deepEqual(parseRepoInput('https://github.com:443/owner/repo/'), { owner: 'owner', repo: 'repo' })
  for (const value of ['', 'owner', 'https://gitlab.com/owner/repo', 'http://github.com/owner/repo', 'https://github.com/owner/repo?x=1', 'https://user@github.com/owner/repo', 'owner/../repo']) {
    assert.throws(() => parseRepoInput(value), undefined, value)
  }
})

test('helper and include contain the token path, never the token', () => {
  const helper = buildHelperScript("/tmp/a b'c/token")
  const config = buildGitConfig({ helperFile: "/tmp/a b'c/credential" })
  assert.ok(!helper.includes(TOKEN))
  assert.ok(!config.includes(TOKEN))
  assert.ok(helper.includes("cat '/tmp/a b'\\''c/token'"))
  assert.match(config, /credential "https:\/\/github\.com"/)
  assert.match(config, /helper = ""/)
  assert.match(config, /!sh '/)
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
})

test('the credential suite can run real git', () => {
  assert.ok(hasGit, '未找到 git 命令：GitHub 凭据用例依赖真实 git，请安装 git 后重新运行。')
})

test('the User-Agent carries the package version', async () => {
  assert.equal(USER_AGENT, `yukari-dsh-plugin/${packageVersion}`)
  let headers = null
  await getUser(TOKEN, {
    fetchImpl: async (url, options) => {
      headers = options.headers
      return new Response(JSON.stringify({ login: 'octocat' }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.equal(headers['user-agent'], `yukari-dsh-plugin/${packageVersion}`)
})

test('readToken tells a missing token apart from an unreadable one', async (t) => {
  const { home } = await fixture(t)
  const store = new GitHubStore({ home })
  await store.ensure()
  assert.equal(await store.readToken(), null)

  // 目录无法按文件读取，这与"文件不存在"是两回事；旧实现把它当成未配置。
  await mkdir(store.paths.tokenFile, { recursive: true })
  await assert.rejects(
    () => store.readToken(),
    (error) => /无法读取令牌文件/.test(error.message) && error.message.includes(store.paths.tokenFile),
  )
})

test('an unreadable token file is an error, not an unconfigured state', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const first = new GitHubController({ home, env, fetchImpl: userFetch() })
  await first.init()
  await first.saveToken(TOKEN)
  await rm(first.paths.tokenFile)
  await mkdir(first.paths.tokenFile)

  const second = new GitHubController({ home, env, fetchImpl: userFetch() })
  await second.init()
  await assert.rejects(() => second.state(), /无法读取令牌文件/)
  assert.deepEqual(await includes(env), [first.paths.includeFile], '读取失败不得摘掉全机 include')
})

test('saveToken persists a 0600 token and installs a scoped include', { skip: needsGit }, async (t) => {
  const { home, gitHome, env } = await fixture(t)
  const controller = new GitHubController({ home, env, fetchImpl: userFetch() })
  await controller.init()
  const state = await controller.saveToken(TOKEN)
  const paths = controller.paths

  assert.equal(state.configured, true)
  assert.equal(state.account.login, 'octocat')
  assert.equal(state.git.helperInstalled, true)
  assert.equal(state.git.available, true)
  assert.ok(!JSON.stringify(state).includes(TOKEN), 'state must not contain the token')

  assert.equal(await readFile(paths.tokenFile, 'utf8'), TOKEN)
  assert.equal((await stat(paths.tokenFile)).mode & 0o777, 0o600)
  assert.equal((await stat(paths.directory)).mode & 0o777, 0o700)
  assert.equal((await stat(paths.helperFile)).mode & 0o777, 0o600)
  assert.equal((await stat(paths.includeFile)).mode & 0o777, 0o600)

  for (const file of [paths.helperFile, paths.includeFile, paths.metaFile, path.join(gitHome, '.gitconfig')]) {
    assert.ok(!(await readFile(file, 'utf8')).includes(TOKEN), `${file} must not contain the token`)
  }
  assert.deepEqual(await includes(env), [paths.includeFile])
})

test('git credential fill returns credentials only for github.com', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const controller = new GitHubController({ home, env, fetchImpl: userFetch() })
  await controller.init()
  await controller.saveToken(TOKEN)

  const github = await fill(env, 'github.com')
  assert.equal(github.error, null)
  assert.match(github.stdout, /username=x-access-token/)
  assert.match(github.stdout, new RegExp(`password=${TOKEN}`))

  const other = await fill(env, 'example.com')
  assert.ok(!other.stdout.includes(TOKEN), 'the helper must not answer another host')
})

test('repeated saves are idempotent and a restart restores the helper', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const first = new GitHubController({ home, env, fetchImpl: userFetch() })
  await first.init()
  await first.saveToken(TOKEN)
  await first.saveToken(TOKEN)
  assert.deepEqual(await includes(env), [first.paths.includeFile])

  await first.dispose()
  assert.deepEqual(await includes(env), [])

  const second = new GitHubController({ home, env, fetchImpl: userFetch() })
  await second.init()
  const state = await second.state()
  assert.equal(state.configured, true)
  assert.equal(state.git.helperInstalled, true)
  assert.deepEqual(await includes(env), [second.paths.includeFile])
})

test('an invalid token never overwrites the stored one', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const controller = new GitHubController({ home, env, fetchImpl: userFetch() })
  await controller.init()
  await controller.saveToken(TOKEN)

  const rejected = new GitHubController({
    home,
    env,
    fetchImpl: async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } }),
  })
  await rejected.init()
  await assert.rejects(() => rejected.saveToken('bad-token'), /令牌无效或已过期/)
  assert.equal(await readFile(controller.paths.tokenFile, 'utf8'), TOKEN)
})

test('fetch errors are redacted before they reach the panel', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const controller = new GitHubController({
    home,
    env,
    fetchImpl: async () => {
      throw new Error(`network failed while sending ${TOKEN}`)
    },
  })
  await controller.init()
  await assert.rejects(
    () => controller.saveToken(TOKEN),
    (error) => !error.message.includes(TOKEN) && error.message.includes('***'),
  )
  assert.equal(redact(`x ${TOKEN} y`, TOKEN), 'x *** y')
})

test('checkRepo maps permissions and keeps the token out of the result', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const seen = []
  const controller = new GitHubController({
    home,
    env,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      seen.push(String(url))
      return new Response(JSON.stringify({ name: 'repo', full_name: 'owner/repo', private: true, default_branch: 'main', html_url: 'https://github.com/owner/repo', permissions: { push: true, pull: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  await controller.init()
  await controller.saveToken(TOKEN)
  const repo = await controller.checkRepo('owner/repo')
  assert.equal(repo.fullName, 'owner/repo')
  assert.equal(repo.private, true)
  assert.equal(repo.canPush, true)
  assert.ok(seen.some((url) => url.endsWith('/repos/owner/repo')), '仓库信息要真的去问 GitHub')
  assert.ok(seen.some((url) => url.includes('/repos/owner/repo/commits')), '顺便取最近一次提交的签名结论')
  assert.equal(repo.latestCommit, null, '桩返回的不是提交列表，面板不编造结论')
  assert.ok(!JSON.stringify(repo).includes(TOKEN))
})

test('token expiry metadata is exposed as expired', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const controller = new GitHubController({ home, env, fetchImpl: userFetch({ expiresAt: '2020-01-01 00:00:00 UTC' }) })
  await controller.init()
  const state = await controller.saveToken(TOKEN)
  assert.equal(state.account.expired, true)
  assert.equal(state.account.expiresAt, '2020-01-01 00:00:00 UTC')
})

test('a token is still stored when the git config cannot be written', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t, { homeIsFile: true })
  const controller = new GitHubController({ home, env, fetchImpl: userFetch() })
  await controller.init()
  const state = await controller.saveToken(TOKEN)
  assert.equal(state.configured, true)
  assert.equal(state.git.helperInstalled, false)
  assert.equal(typeof state.git.error, 'string')
  assert.equal(await readFile(controller.paths.tokenFile, 'utf8'), TOKEN)
})

test('clear revokes the token and removes the include', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const controller = new GitHubController({ home, env, fetchImpl: userFetch() })
  await controller.init()
  await controller.saveToken(TOKEN)
  await controller.clear()
  const state = await controller.state()
  assert.equal(state.configured, false)
  assert.deepEqual(await includes(env), [])
  await assert.rejects(() => stat(controller.paths.tokenFile))
  const attempt = await fill(env, 'github.com')
  assert.ok(!attempt.stdout.includes(TOKEN))
})

test('init repairs an over-wide token mode', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const first = new GitHubController({ home, env, fetchImpl: userFetch() })
  await first.init()
  await first.saveToken(TOKEN)
  await chmod(first.paths.tokenFile, 0o644)
  const second = new GitHubController({ home, env, fetchImpl: userFetch() })
  await second.init()
  assert.equal((await stat(second.paths.tokenFile)).mode & 0o777, 0o600)
})

test('inspect reports git unavailable without throwing', async (t) => {
  const { home, env } = await fixture(t)
  const controller = new GitHubController({ home, env, gitCommand: 'yukari-no-such-git', fetchImpl: userFetch() })
  await controller.init()
  const state = await controller.state()
  assert.equal(state.git.available, false)
  assert.equal(typeof state.git.error, 'string')
})

test('getUser keeps token metadata and GitHub error messages clean', { skip: needsGit }, async () => {
  const account = await getUser(TOKEN, { fetchImpl: userFetch({ scopes: 'repo, workflow', login: 'me' }) })
  assert.equal(account.login, 'me')
  assert.equal(account.tokenType, 'classic')
  assert.deepEqual(account.scopes, ['repo', 'workflow'])

  await assert.rejects(
    () => getUser(TOKEN, { fetchImpl: async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } }) }),
    (error) => !error.message.includes(TOKEN) && /401/.test(error.message),
  )
})

test('the token route reads the header and never echoes the token', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const previous = {}
  for (const key of ['DSH_HOME', 'HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL']) previous[key] = process.env[key]
  const realFetch = globalThis.fetch
  process.env.DSH_HOME = home
  process.env.HOME = env.HOME
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME
  process.env.GIT_CONFIG_NOSYSTEM = env.GIT_CONFIG_NOSYSTEM
  delete process.env.GIT_CONFIG_GLOBAL
  globalThis.fetch = userFetch()
  t.after(() => {
    globalThis.fetch = realFetch
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const routes = []
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {} },
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      const result = fn()
      if (result !== null && typeof result?.then === 'function') effects.push(result)
      return () => {}
    },
    root: {},
  }
  apply(ctx)
  await Promise.all(effects)
  assert.equal(routes.length, 1)
  const route = routes[0]

  const call = async (method, url, body, headers = {}) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url,
      headers,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }
    const res = {
      statusCode: 0,
      headers: {},
      headersSent: false,
      body: '',
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(text) {
        this.body = text ?? ''
        this.headersSent = true
      },
    }
    await route.handler(req, res)
    return { status: res.statusCode, json: res.body === '' ? null : JSON.parse(res.body) }
  }

  const saved = await call('POST', '/github/api/token', {}, { 'x-yukari-github-token': TOKEN })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.state.configured, true)
  assert.ok(!JSON.stringify(saved.json).includes(TOKEN), 'the token route must not echo the token')

  const state = await call('GET', '/github/api/state')
  assert.equal(state.status, 200)
  assert.ok(!JSON.stringify(state.json).includes(TOKEN), 'the state route must not expose the token')

  const missing = await call('POST', '/github/api/token', {}, {})
  assert.equal(missing.status, 400)
  assert.match(missing.json.error, /令牌/)

  const cleared = await call('POST', '/github/api/clear')
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.state.configured, false)
})

test('disposing one controller keeps the shared include for the other', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const first = new GitHubController({ home, env, fetchImpl: userFetch() })
  await first.init()
  await first.saveToken(TOKEN)
  const second = new GitHubController({ home, env, fetchImpl: userFetch() })
  await second.init()

  await first.dispose()
  const state = await second.state()
  assert.equal(state.git.helperInstalled, true)
  assert.deepEqual(await includes(env), [first.paths.includeFile])

  const attempt = await fill(env, 'github.com')
  assert.match(attempt.stdout, new RegExp(`password=${TOKEN}`))

  await second.dispose()
  assert.deepEqual(await includes(env), [], '最后一个持有者退出时才摘 include')
})

test('helper and include are replaced through an atomic rename', async (t) => {
  const { home } = await fixture(t)
  const store = new GitHubStore({ home })
  const git = new GitCredential({ paths: store.paths, gitCommand: 'yukari-no-such-git' })

  assert.equal((await git.install()).ok, false, 'git 不可用时仍应先把文件落盘')
  const before = { helper: await stat(store.paths.helperFile), include: await stat(store.paths.includeFile) }
  await git.install()
  const after = { helper: await stat(store.paths.helperFile), include: await stat(store.paths.includeFile) }

  // 原地截断写入会保留 inode；先写临时文件再 rename 一定换一个新 inode。
  assert.notEqual(after.helper.ino, before.helper.ino, 'helper 必须是整体替换')
  assert.notEqual(after.include.ino, before.include.ino, 'include 必须是整体替换')
  assert.equal((await stat(store.paths.helperFile)).mode & 0o777, 0o600)
  assert.equal((await stat(store.paths.includeFile)).mode & 0o777, 0o600)
  assert.match(await readFile(store.paths.helperFile, 'utf8'), /Managed by yukari-dsh-plugin/)
  assert.deepEqual(
    (await readdir(store.paths.directory)).filter((name) => name.endsWith('.tmp')),
    [],
    '临时文件必须清理干净',
  )
})

test('concurrent token writes never collide on the temporary file', async (t) => {
  const { home } = await fixture(t)
  const store = new GitHubStore({ home })
  const values = Array.from({ length: 8 }, (_, index) => `token-${index}`)
  await Promise.all(values.map((value) => store.writeToken(value)))
  assert.ok(values.includes(await store.readToken()))
  assert.deepEqual(
    (await readdir(store.paths.directory)).filter((name) => name.endsWith('.tmp')),
    [],
  )
})

test('API failures never echo the token', async () => {
  await assert.rejects(
    () =>
      getUser(TOKEN, {
        fetchImpl: async () => {
          throw new Error(`socket closed while sending ${TOKEN}`)
        },
      }),
    (error) => !error.message.includes(TOKEN) && error.message.includes('***'),
  )
  await assert.rejects(
    () =>
      getUser(TOKEN, {
        fetchImpl: async () =>
          new Response(JSON.stringify({ message: `bad credentials ${TOKEN}` }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    (error) => !error.message.includes(TOKEN),
  )
})

test('git output is redacted before it reaches the state', { skip: needsGit }, async (t) => {
  const { home } = await fixture(t)
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yukari fake git '))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fakeGit = path.join(directory, 'fake-git')
  await writeFile(fakeGit, `#!/bin/sh\necho "fatal: authentication failed for ${TOKEN}" >&2\nexit 1\n`, { mode: 0o700 })

  const logs = []
  const controller = new GitHubController({ home, gitCommand: fakeGit, log: (message) => logs.push(message), fetchImpl: userFetch() })
  await controller.init()
  const state = await controller.saveToken(TOKEN)
  assert.equal(state.git.helperInstalled, false)
  assert.equal(typeof state.git.error, 'string')
  assert.ok(!state.git.error.includes(TOKEN), 'git 输出里的令牌必须被脱敏')
  assert.match(state.git.error, /\*\*\*/)
  assert.ok(!JSON.stringify(state).includes(TOKEN))
  assert.ok(logs.length > 0)
  assert.ok(logs.every((message) => !message.includes(TOKEN)), '日志里不得出现令牌')
})

/** 一页 JSON 响应。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * 假的 GitHub：`/user`、签名密钥的增删查、以及可选的拒绝。
 * 记录每次请求，用来断言"先找后建""关闭时注销"。
 */
function signingFetch({ registered = [], refuse = null } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    const method = init.method ?? 'GET'
    calls.push({ target, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : null })
    if (target.endsWith('/user')) return jsonResponse({ login: 'octocat' })
    if (target.includes('/user/ssh_signing_keys')) {
      if (refuse !== null) return jsonResponse({ message: refuse.message }, refuse.status)
      if (method === 'GET') return jsonResponse(registered)
      if (method === 'POST') {
        const body = JSON.parse(init.body)
        return jsonResponse({ id: 42, key: body.key, title: body.title }, 201)
      }
      if (method === 'DELETE') return new Response(null, { status: 204 })
    }
    return jsonResponse({ message: 'no stub' }, 404)
  }
  return { fetchImpl, calls }
}

test('the include signs commits only when a signing key exists', () => {
  const plain = buildGitConfig({ helperFile: '/tmp/credential' })
  assert.equal(plain.includes('signingkey'), false)
  assert.equal(plain.includes('gpgsign'), false)

  const signed = buildGitConfig({ helperFile: '/tmp/credential', signingKeyFile: '/home/u/signing.pub' })
  assert.match(signed, /\[gpg\]\n\tformat = ssh/)
  assert.match(signed, /\[commit\]\n\tgpgsign = true/)
  assert.match(signed, /signingkey = "\/home\/u\/signing\.pub"/)
  assert.match(signed, /credential "https:\/\/github\.com"/)
  assert.equal(signed.includes('allowedSignersFile'), false, '没有公钥就没有验证文件')

  // 本地校验也要能跑：`git verify-commit` / `%G?` 依赖这个文件。
  const verifiable = buildGitConfig({ helperFile: '/tmp/credential', signingKeyFile: '/home/u/signing.pub', allowedSignersFile: '/home/u/allowed_signers' })
  assert.match(verifiable, /\[gpg "ssh"\]\n\tallowedSignersFile = "\/home\/u\/allowed_signers"/)
})

test('local verification works without extra git config', { skip: needsGit || needsSshKeygen }, async (t) => {
  const { root, home, env } = await fixture(t)
  const controller = new GitHubController({ home, env, fetchImpl: signingFetch().fetchImpl })
  await controller.init()
  await controller.saveToken(TOKEN)
  await controller.enableSigning()

  const allowed = controller.paths.signingAllowedSignersFile
  assert.match(await readFile(allowed, 'utf8'), /^\* ssh-ed25519 /)
  assert.equal((await stat(allowed)).mode & 0o777, 0o600)
  assert.match(await readFile(controller.paths.includeFile, 'utf8'), /allowedSignersFile = /)

  const repo = path.join(root, 'repo')
  await mkdir(repo)
  await run('git', ['init', '-q'], { env, cwd: repo })
  await run('git', ['config', 'user.name', 'Tester'], { env, cwd: repo })
  await run('git', ['config', 'user.email', 'tester@example.com'], { env, cwd: repo })
  await writeFile(path.join(repo, 'a.txt'), 'signed\n')
  await run('git', ['add', 'a.txt'], { env, cwd: repo })
  const commit = await run('git', ['commit', '-m', 'signed'], { env, cwd: repo })
  assert.equal(commit.error, null, commit.stderr)

  const verdict = await run('git', ['log', '-1', '--format=%G?'], { env, cwd: repo })
  assert.equal(verdict.stdout.trim(), 'G', '本地就能判定签名有效，不用再看 GitHub')
  const verified = await run('git', ['verify-commit', 'HEAD'], { env, cwd: repo })
  assert.equal(verified.error, null, verified.stderr)
})

test('supportsSshSigning follows the 2.34 boundary', () => {
  assert.equal(supportsSshSigning('2.34.0'), true)
  assert.equal(supportsSshSigning('2.39.5'), true)
  assert.equal(supportsSshSigning('3.0.0'), true)
  assert.equal(supportsSshSigning('2.33.9'), false)
  assert.equal(supportsSshSigning('1.9.0'), false)
  assert.equal(supportsSshSigning(''), false)
  assert.equal(supportsSshSigning(null), false)
})

test('the generated key signs a commit that git verifies', { skip: needsGit || needsSshKeygen }, async (t) => {
  const { root, home, env } = await fixture(t)
  const key = new SigningKey({ paths: new GitHubStore({ home }).paths })
  const created = await key.generate()
  assert.match(created.publicKey, /^ssh-ed25519 /)
  assert.match(created.fingerprint, /^SHA256:/)
  assert.equal((await stat(key.paths.signingKeyFile)).mode & 0o777, 0o600)
  assert.equal((await stat(key.paths.signingPublicKeyFile)).mode & 0o777, 0o600)

  const repoDir = path.join(root, 'repo')
  await mkdir(repoDir)
  await run('git', ['init', '-q'], { env, cwd: repoDir })
  await run('git', ['config', 'user.name', 'Tester'], { env, cwd: repoDir })
  await run('git', ['config', 'user.email', 'tester@example.com'], { env, cwd: repoDir })
  // 只装签名这一半配置：用 include 的写法验证 git 真的会读它。
  const includeFile = path.join(root, 'include')
  await writeFile(includeFile, buildGitConfig({ helperFile: path.join(root, 'credential'), signingKeyFile: key.paths.signingPublicKeyFile }))
  await run('git', ['config', '--global', '--add', 'include.path', includeFile], { env })
  await writeFile(path.join(repoDir, 'a.txt'), 'signed\n')
  await run('git', ['add', 'a.txt'], { env, cwd: repoDir })
  const commit = await run('git', ['commit', '-m', 'signed'], { env, cwd: repoDir })
  assert.equal(commit.error, null, commit.stderr)

  const raw = await run('git', ['cat-file', '-p', 'HEAD'], { env, cwd: repoDir })
  assert.match(raw.stdout, /^gpgsig -----BEGIN SSH SIGNATURE-----/m)

  const allowed = path.join(root, 'allowed_signers')
  await writeFile(allowed, `tester@example.com ${created.publicKey}\n`)
  await run('git', ['config', 'gpg.ssh.allowedSignersFile', allowed], { env, cwd: repoDir })
  const verified = await run('git', ['verify-commit', 'HEAD'], { env, cwd: repoDir })
  assert.equal(verified.error, null, verified.stderr)
  assert.match(verified.stderr, /Good "git" signature for tester@example.com/)
})

test('enableSigning registers the key and turns signing on', { skip: needsGit || needsSshKeygen }, async (t) => {
  const { home, env } = await fixture(t)
  const fake = signingFetch()
  const controller = new GitHubController({ home, env, fetchImpl: fake.fetchImpl })
  await controller.init()
  await controller.saveToken(TOKEN)

  const state = await controller.enableSigning()
  assert.equal(state.signing.enabled, true)
  assert.equal(state.signing.registered, true)
  assert.equal(state.signing.error, null)
  assert.match(state.signing.publicKey, /^ssh-ed25519 /)
  assert.ok(!JSON.stringify(state).includes(TOKEN), 'state must not contain the token')

  const posted = fake.calls.filter((call) => call.method === 'POST')
  assert.equal(posted.length, 1, 'the key is registered once')
  assert.equal(posted[0].body.title, 'yukari-dsh-plugin')
  assert.equal(posted[0].body.key, state.signing.publicKey)

  const include = await readFile(controller.paths.includeFile, 'utf8')
  assert.match(include, /format = ssh/)
  assert.ok(include.includes(controller.paths.signingPublicKeyFile))

  // 重新启用不该再登记一把：同一把公钥已经在账号上。
  fake.calls.length = 0
  fake.fetchImpl = signingFetch({ registered: [{ id: 42, key: state.signing.publicKey, title: 'yukari-dsh-plugin' }] }).fetchImpl
  const again = await new GitHubController({ home, env, fetchImpl: fake.fetchImpl })
  await again.init()
  const second = await again.enableSigning()
  assert.equal(second.signing.registered, true)
  assert.equal(second.signing.fingerprint, state.signing.fingerprint)
})

test('a refused registration still leaves local signing in place', { skip: needsGit || needsSshKeygen }, async (t) => {
  const { home, env } = await fixture(t)
  const fake = signingFetch({ refuse: { status: 403, message: 'Resource not accessible by personal access token' } })
  const controller = new GitHubController({ home, env, fetchImpl: fake.fetchImpl })
  await controller.init()
  await controller.saveToken(TOKEN)

  const state = await controller.enableSigning()
  assert.equal(state.signing.enabled, true, '本地照样签名')
  assert.equal(state.signing.registered, false)
  assert.match(state.signing.error, /403/, '拒绝原因要报出来，不能静默')
  assert.match(await readFile(controller.paths.includeFile, 'utf8'), /format = ssh/)

  // 令牌读不到列表时，公钥只能手动添加；添加之后状态不能一直显示「未登记」。
  const marked = await controller.markSigningManual()
  assert.equal(marked.signing.registered, true)
  assert.equal(marked.signing.manual, true, '手动登记要和自动登记区分开')
  assert.equal(marked.signing.error, null)
  assert.equal(typeof marked.signing.registeredAt, 'string')
})

test('markSigningManual refuses before a key exists', { skip: needsGit || needsSshKeygen }, async (t) => {
  const { home, env } = await fixture(t)
  const controller = new GitHubController({ home, env, fetchImpl: signingFetch().fetchImpl })
  await controller.init()
  await controller.saveToken(TOKEN)
  await assert.rejects(() => controller.markSigningManual(), /尚未生成签名密钥/)
})

test('disableSigning unregisters the key and stops signing', { skip: needsGit || needsSshKeygen }, async (t) => {
  const { home, env } = await fixture(t)
  const fake = signingFetch()
  const controller = new GitHubController({ home, env, fetchImpl: fake.fetchImpl })
  await controller.init()
  await controller.saveToken(TOKEN)
  await controller.enableSigning()

  const state = await controller.disableSigning()
  assert.equal(state.signing.enabled, false)
  assert.equal(state.signing.publicKey, null)
  assert.equal(state.signing.error, null)
  assert.ok(fake.calls.some((call) => call.method === 'DELETE' && call.target.endsWith('/user/ssh_signing_keys/42')))
  await assert.rejects(() => stat(controller.paths.signingKeyFile))
  assert.equal((await readFile(controller.paths.includeFile, 'utf8')).includes('signingkey'), false)
})

test('enableSigning refuses an old git before touching anything', { skip: needsGit || needsSshKeygen }, async (t) => {
  const { home, env } = await fixture(t)
  const oldGit = path.join(home, 'old-git')
  // 一个只会报 2.30 的假 git：其它子命令一律失败，正好验证"先查版本再动手"。
  await writeFile(oldGit, '#!/bin/sh\n[ "$1" = "--version" ] && echo "git version 2.30.1" && exit 0\nexit 1\n')
  await chmod(oldGit, 0o755)
  const fake = signingFetch()
  const controller = new GitHubController({ home, env, gitCommand: oldGit, fetchImpl: fake.fetchImpl })
  await controller.init()
  await controller.saveToken(TOKEN)
  await assert.rejects(() => controller.enableSigning(), /2\.34/)
  assert.equal(await readFile(controller.paths.signingPublicKeyFile, 'utf8').catch(() => null), null)
})

test('checkRepo reports the latest commit signature verdict', { skip: needsGit }, async (t) => {
  const { home, env } = await fixture(t)
  const controller = new GitHubController({
    home,
    env,
    fetchImpl: async (url) => {
      const target = String(url)
      if (target.endsWith('/user')) return jsonResponse({ login: 'octocat' })
      if (target.includes('/commits')) {
        return jsonResponse([{
          sha: 'abcdef1234567890',
          html_url: 'https://github.com/owner/repo/commit/abcdef1234567890',
          commit: { message: 'signed work\n\nbody', verification: { verified: true, reason: 'valid', verified_at: '2026-01-01T00:00:00Z' } },
        }])
      }
      return jsonResponse({ name: 'repo', full_name: 'owner/repo', permissions: { push: true } })
    },
  })
  await controller.init()
  await controller.saveToken(TOKEN)
  const repo = await controller.checkRepo('owner/repo')
  assert.equal(repo.latestCommit.sha, 'abcdef1234567890')
  assert.equal(repo.latestCommit.message, 'signed work')
  assert.deepEqual(repo.latestCommit.verification, { verified: true, reason: 'valid', verifiedAt: '2026-01-01T00:00:00Z' })
  assert.equal(repo.latestCommitError, null)

  const empty = new GitHubController({
    home,
    env,
    fetchImpl: async (url) => String(url).includes('/commits')
      ? jsonResponse({ message: 'Git Repository is empty.' }, 409)
      : jsonResponse({ login: 'octocat', full_name: 'owner/repo' }),
  })
  await empty.init()
  const noCommits = await empty.checkRepo('owner/repo')
  assert.equal(noCommits.latestCommit, null, '空仓库不是错误，只是没有提交可看')
  assert.equal(noCommits.latestCommitError, null)
})

test('enableSigning refuses to fight an existing signing setup', { skip: needsGit || needsSshKeygen }, async (t) => {
  const { home, env } = await fixture(t)
  const setup = await run('git', ['config', '--global', 'gpg.format', 'openpgp'], { env })
  assert.equal(setup.error, null, setup.stderr)
  const controller = new GitHubController({ home, env, fetchImpl: signingFetch().fetchImpl })
  await controller.init()
  await controller.saveToken(TOKEN)

  await assert.rejects(() => controller.enableSigning(), /gpg\.format = openpgp/)
  assert.equal(await readFile(controller.paths.signingPublicKeyFile, 'utf8').catch(() => null), null, '冲突没解决就不生成密钥')
})

test('an override after the include is reported, never hidden', { skip: needsGit || needsSshKeygen }, async (t) => {
  const { home, gitHome, env } = await fixture(t)
  const fake = signingFetch()
  const controller = new GitHubController({ home, env, fetchImpl: fake.fetchImpl })
  await controller.init()
  await controller.saveToken(TOKEN)
  assert.equal((await controller.enableSigning()).signing.enabled, true)

  // 用户自己的设置写在 include 之后就会赢；这时不能还显示「已启用」。
  await writeFile(path.join(gitHome, '.gitconfig'), `${await readFile(path.join(gitHome, '.gitconfig'), 'utf8')}\n[commit]\n\tgpgsign = false\n`)
  assert.equal((await controller.state()).signing.enabled, false)

  const retried = await controller.enableSigning()
  assert.equal(retried.signing.enabled, false)
  assert.match(retried.signing.error, /未生效/, '必须说清配置没有生效')
})

test('init restores the allowed signers file for an existing key', { skip: needsGit || needsSshKeygen }, async (t) => {
  const { home, env } = await fixture(t)
  const first = new GitHubController({ home, env, fetchImpl: signingFetch().fetchImpl })
  await first.init()
  await first.saveToken(TOKEN)
  await first.enableSigning()

  // 模拟 1.14.61 留下的状态：只有签名配置，没有验证文件。
  await rm(first.paths.signingAllowedSignersFile)
  await first.install()
  assert.equal((await readFile(first.paths.includeFile, 'utf8')).includes('allowedSignersFile'), false)

  const second = new GitHubController({ home, env, fetchImpl: signingFetch().fetchImpl })
  await second.init()
  assert.match(await readFile(second.paths.signingAllowedSignersFile, 'utf8'), /^\* ssh-ed25519 /)
  assert.match(await readFile(second.paths.includeFile, 'utf8'), /allowedSignersFile = /)
  assert.equal((await second.state()).signing.enabled, true)
})
