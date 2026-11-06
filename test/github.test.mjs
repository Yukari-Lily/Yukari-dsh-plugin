import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getUser, parseRepoInput } from '../host/github/lib/api.js'
import { GitHubController, redact } from '../host/github/lib/controller.js'
import { apply } from '../host/github/index.js'
import { buildGitConfig, buildHelperScript, shellQuote } from '../host/github/lib/git.js'

const TOKEN = 'test-token-abcdef'
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

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
function run(command, args, { env, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { env, timeout: 15000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
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

test('saveToken persists a 0600 token and installs a scoped include', { skip: !hasGit }, async (t) => {
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

test('git credential fill returns credentials only for github.com', { skip: !hasGit }, async (t) => {
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

test('repeated saves are idempotent and a restart restores the helper', { skip: !hasGit }, async (t) => {
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

test('an invalid token never overwrites the stored one', { skip: !hasGit }, async (t) => {
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

test('fetch errors are redacted before they reach the panel', { skip: !hasGit }, async (t) => {
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

test('checkRepo maps permissions and keeps the token out of the result', { skip: !hasGit }, async (t) => {
  const { home, env } = await fixture(t)
  let seen = null
  const controller = new GitHubController({
    home,
    env,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'octocat' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      seen = String(url)
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
  assert.ok(seen.endsWith('/repos/owner/repo'))
  assert.ok(!JSON.stringify(repo).includes(TOKEN))
})

test('token expiry metadata is exposed as expired', { skip: !hasGit }, async (t) => {
  const { home, env } = await fixture(t)
  const controller = new GitHubController({ home, env, fetchImpl: userFetch({ expiresAt: '2020-01-01 00:00:00 UTC' }) })
  await controller.init()
  const state = await controller.saveToken(TOKEN)
  assert.equal(state.account.expired, true)
  assert.equal(state.account.expiresAt, '2020-01-01 00:00:00 UTC')
})

test('a token is still stored when the git config cannot be written', { skip: !hasGit }, async (t) => {
  const { home, env } = await fixture(t, { homeIsFile: true })
  const controller = new GitHubController({ home, env, fetchImpl: userFetch() })
  await controller.init()
  const state = await controller.saveToken(TOKEN)
  assert.equal(state.configured, true)
  assert.equal(state.git.helperInstalled, false)
  assert.equal(typeof state.git.error, 'string')
  assert.equal(await readFile(controller.paths.tokenFile, 'utf8'), TOKEN)
})

test('clear revokes the token and removes the include', { skip: !hasGit }, async (t) => {
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

test('init repairs an over-wide token mode', { skip: !hasGit }, async (t) => {
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

test('getUser keeps token metadata and GitHub error messages clean', { skip: !hasGit }, async () => {
  const account = await getUser(TOKEN, { fetchImpl: userFetch({ scopes: 'repo, workflow', login: 'me' }) })
  assert.equal(account.login, 'me')
  assert.equal(account.tokenType, 'classic')
  assert.deepEqual(account.scopes, ['repo', 'workflow'])

  await assert.rejects(
    () => getUser(TOKEN, { fetchImpl: async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } }) }),
    (error) => !error.message.includes(TOKEN) && /401/.test(error.message),
  )
})

test('the token route reads the header and never echoes the token', { skip: !hasGit }, async (t) => {
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
