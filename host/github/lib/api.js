/**
 * GitHub REST calls used by the Github component.
 *
 * Every request carries the token only in the Authorization header. Error
 * messages are written for the panel and never include the request headers or
 * the token itself.
 * @module yukari-dsh-plugin/github/api
 */
import { readFileSync } from 'node:fs'
import { redact } from './redact.js'

const API_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const TIMEOUT_MS = 10000

/** 模块加载时读一次版本，避免每个请求都碰磁盘；发出去的 User-Agent 得是真实版本。 */
const PACKAGE = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
export const USER_AGENT = `yukari-dsh-plugin/${PACKAGE.version}`

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** An error with the HTTP status attached, so callers can classify it. */
export class GitHubApiError extends Error {
  constructor(message, { status = null, rateLimited = false } = {}) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
    this.rateLimited = rateLimited
  }
}

/** One owned segment of an owner/repository pair. */
function isSegment(value) {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..'
}

/** Strip a trailing `.git` and slash from one path segment. */
function cleanSegment(value) {
  return String(value ?? '').replace(/\/+$/, '').replace(/\.git$/i, '')
}

/**
 * Parse `owner/repo`, a github.com HTTPS URL, or the scp form.
 * @param value - user input.
 * @returns `{ owner, repo }`.
 * @throws when the input is not a github.com repository.
 */
export function parseRepoInput(value) {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error('请输入 owner/repo')

  const fromUrl = (() => {
    if (!/^https?:\/\//i.test(text)) return null
    try {
      const url = new URL(text)
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
      if (url.hostname.toLowerCase() !== 'github.com') return null
      if (url.port !== '' && url.port !== '443') return null
      if (url.search !== '' || url.hash !== '') return null
      const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
      if (parts.length !== 2) return null
      return { owner: cleanSegment(parts[0]), repo: cleanSegment(parts[1]) }
    } catch {
      return null
    }
  })()
  if (fromUrl !== null) return checked(fromUrl)

  const scp = /^(?:[^@/]+@)?github\.com:([^/]+)\/([^/]+?)\/?$/.exec(text)
  if (scp !== null) return checked({ owner: cleanSegment(scp[1]), repo: cleanSegment(scp[2]) })

  const bare = /^([^/]+)\/([^/]+?)\/?$/.exec(text)
  if (bare !== null) return checked({ owner: cleanSegment(bare[1]), repo: cleanSegment(bare[2]) })

  throw new Error('仓库格式应为 owner/repo，或 https://github.com/owner/repo')
}

/** Validate a parsed pair. */
function checked(value) {
  if (!isSegment(value.owner) || !isSegment(value.repo)) {
    throw new Error('仓库名只能包含字母、数字、点、下划线和短横线')
  }
  return { owner: value.owner, repo: value.repo }
}

/** Parse token metadata from response headers. */
export function inspectToken(headers, token) {
  const scopesHeader = headers.get('x-oauth-scopes')
  const scopes = scopesHeader === null
    ? []
    : scopesHeader.split(',').map((scope) => scope.trim()).filter((scope) => scope !== '')
  const expiresAt = headers.get('github-authentication-token-expiration')
  const parsed = expiresAt === null ? NaN : Date.parse(expiresAt)
  const expired = Number.isFinite(parsed) ? parsed <= Date.now() : false
  const tokenType = String(token ?? '').startsWith('github_pat_')
    ? 'fine-grained'
    : scopesHeader !== null
      ? 'classic'
      : 'unknown'
  return {
    tokenType,
    scopes,
    expiresAt: expiresAt === null || expiresAt === '' ? null : expiresAt,
    expired,
  }
}

/** Map one non-2xx GitHub response to a human-facing error. */
function apiError(response, body) {
  const status = response.status
  const detail = typeof body?.message === 'string' ? body.message : ''
  const remaining = response.headers.get('x-ratelimit-remaining')
  if (status === 401) return new GitHubApiError('令牌无效或已过期（GitHub 401）', { status })
  if (status === 403 && remaining === '0') return new GitHubApiError('GitHub API 限流，稍后再试', { status, rateLimited: true })
  if (status === 403) return new GitHubApiError(`令牌无访问权限（GitHub 403${detail === '' ? '' : `：${detail}`}）`, { status })
  if (status === 404) return new GitHubApiError('仓库不存在，或该令牌未获授权访问（GitHub 404）', { status })
  if (status === 429) return new GitHubApiError('GitHub API 限流，稍后再试', { status, rateLimited: true })
  if (status >= 500) return new GitHubApiError(`GitHub 暂时不可用（${status}）`, { status })
  return new GitHubApiError(`GitHub API ${status}${detail === '' ? '' : `：${detail}`}`, { status })
}

/** One authenticated JSON request. */
async function requestJson(path, token, { fetchImpl = fetch, method = 'GET', json = null } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': API_VERSION,
        'user-agent': USER_AGENT,
        ...(json === null ? {} : { 'content-type': 'application/json' }),
      },
      body: json === null ? undefined : JSON.stringify(json),
      signal: controller.signal,
    })
    const text = await response.text()
    let body = null
    if (text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }
    if (!response.ok) {
      // GitHub 的 message 字段、代理返回的错误页都可能原样回显请求内容，统一先脱敏。
      const mapped = apiError(response, body)
      throw new GitHubApiError(redact(mapped.message, token), { status: mapped.status, rateLimited: mapped.rateLimited })
    }
    return { body, headers: response.headers }
  } catch (error) {
    if (error instanceof GitHubApiError) throw error
    if (error?.name === 'AbortError') throw new GitHubApiError('连接 GitHub API 超时（检查网络或代理）')
    throw new GitHubApiError(redact(`无法连接 GitHub API（${messageOf(error)}）`, token))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read the authenticated account.
 * @param token - the PAT.
 * @returns account fields plus token metadata.
 */
export async function getUser(token, options = {}) {
  const { body, headers } = await requestJson('/user', token, options)
  if (body === null || typeof body.login !== 'string' || body.login === '') {
    throw new GitHubApiError('GitHub 返回的用户信息不完整')
  }
  return {
    login: body.login,
    name: typeof body.name === 'string' ? body.name : '',
    avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url : '',
    htmlUrl: typeof body.html_url === 'string' ? body.html_url : '',
    ...inspectToken(headers, token),
  }
}

/**
 * Read one repository and its permissions for the token's user.
 * @returns `{ owner, name, fullName, private, defaultBranch, htmlUrl, permissions, canPush }`.
 */
export async function getRepo(token, owner, repo, options = {}) {
  const { body } = await requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token, options)
  if (body === null || typeof body !== 'object') throw new GitHubApiError('GitHub 返回的仓库信息不完整')
  const source = body.permissions !== null && typeof body.permissions === 'object' ? body.permissions : {}
  const permissions = {
    admin: source.admin === true,
    maintain: source.maintain === true,
    push: source.push === true,
    triage: source.triage === true,
    pull: source.pull === true,
  }
  return {
    owner,
    name: typeof body.name === 'string' ? body.name : repo,
    fullName: typeof body.full_name === 'string' ? body.full_name : `${owner}/${repo}`,
    private: body.private === true,
    defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : '',
    htmlUrl: typeof body.html_url === 'string' ? body.html_url : `https://github.com/${owner}/${repo}`,
    permissions,
    canPush: permissions.push,
  }
}

/** 一页签名密钥的形状。 */
function signingKeyOf(item) {
  if (item === null || typeof item !== 'object') return null
  if (typeof item.key !== 'string' || item.key === '') return null
  return {
    id: Number(item.id),
    key: item.key,
    title: typeof item.title === 'string' ? item.title : '',
    createdAt: typeof item.created_at === 'string' ? item.created_at : null,
  }
}

/**
 * Every SSH signing key registered on the account.
 *
 * 重新启用时要先看这把公钥是否已经在账号上，避免重复登记被 GitHub 拒绝。
 * @param token - the PAT.
 * @returns `{ id, key, title, createdAt }`.
 */
export async function listSigningKeys(token, options = {}) {
  const keys = []
  let path = '/user/ssh_signing_keys?per_page=100'
  // 最多翻十页；分页没有尽头时也不能把请求拖死。
  for (let page = 0; page < 10 && path !== null; page += 1) {
    const { body, headers } = await requestJson(path, token, options)
    if (!Array.isArray(body)) throw new GitHubApiError('GitHub 返回的签名密钥列表不完整')
    for (const item of body) {
      const key = signingKeyOf(item)
      if (key !== null && Number.isInteger(key.id)) keys.push(key)
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') ?? '')
    const target = next?.[1] ?? ''
    path = target.startsWith(API_BASE) ? target.slice(API_BASE.length) : null
  }
  return keys
}

/**
 * Register one SSH signing key on the account.
 * @param token - the PAT.
 * @param options.title - label shown on GitHub.
 * @param options.key - public key text.
 * @returns `{ id, key, title }`.
 */
export async function addSigningKey(token, { title, key }, options = {}) {
  const { body } = await requestJson('/user/ssh_signing_keys', token, { ...options, method: 'POST', json: { title, key } })
  if (body === null || typeof body !== 'object' || !Number.isInteger(Number(body.id))) {
    throw new GitHubApiError('GitHub 返回的签名密钥信息不完整')
  }
  return { id: Number(body.id), key: typeof body.key === 'string' ? body.key : key, title: typeof body.title === 'string' ? body.title : title }
}

/**
 * Delete one SSH signing key from the account.
 * @param token - the PAT.
 * @param id - key id from `listSigningKeys` or `addSigningKey`.
 */
export async function removeSigningKey(token, id, options = {}) {
  await requestJson(`/user/ssh_signing_keys/${encodeURIComponent(id)}`, token, { ...options, method: 'DELETE' })
}

/** 最近一次提交的签名结论；面板据此判断 Verified 是否真的生效。 */
function commitOf(raw) {
  const commit = raw?.commit
  const verification = commit?.verification
  return {
    sha: typeof raw?.sha === 'string' ? raw.sha : '',
    message: typeof commit?.message === 'string' ? commit.message.split('\n')[0] : '',
    htmlUrl: typeof raw?.html_url === 'string' ? raw.html_url : '',
    verification: {
      verified: verification?.verified === true,
      reason: typeof verification?.reason === 'string' ? verification.reason : '',
      verifiedAt: typeof verification?.verified_at === 'string' ? verification.verified_at : null,
    },
  }
}

/**
 * The newest commit on the default branch, with GitHub's signature verdict.
 *
 * GitHub 只在提交真正带签名、且签名密钥属于账号时才回报 `verified: true`；面板拿
 * 这个结论当证据，而不是自己猜签名有没有生效。
 * @param token - the PAT.
 * @param owner - repository owner.
 * @param repo - repository name.
 * @returns the commit, or null for a repository without commits.
 */
export async function getLatestCommit(token, owner, repo, options = {}) {
  let listed
  try {
    listed = await requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=1`, token, options)
  } catch (error) {
    // 空仓库没有提交，GitHub 回 409；这不是错误。
    if (error instanceof GitHubApiError && error.status === 409) return null
    throw error
  }
  const body = listed.body
  if (!Array.isArray(body) || body.length === 0) return null
  const commit = commitOf(body[0])
  return commit.sha === '' ? null : commit
}
