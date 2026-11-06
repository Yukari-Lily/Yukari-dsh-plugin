/**
 * GitHub REST calls used by the Github component.
 *
 * Every request carries the token only in the Authorization header. Error
 * messages are written for the panel and never include the request headers or
 * the token itself.
 * @module yukari-dsh-plugin/github/api
 */
const API_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'yukari-dsh-plugin/1.10.0'
const TIMEOUT_MS = 10000

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
  if (status === 403) return new GitHubApiError(`令牌没有访问权限（GitHub 403${detail === '' ? '' : `：${detail}`}）`, { status })
  if (status === 404) return new GitHubApiError('仓库不存在，或这枚令牌没有被授权访问它（GitHub 404）', { status })
  if (status === 429) return new GitHubApiError('GitHub API 限流，稍后再试', { status, rateLimited: true })
  if (status >= 500) return new GitHubApiError(`GitHub 暂时不可用（${status}）`, { status })
  return new GitHubApiError(`GitHub API ${status}${detail === '' ? '' : `：${detail}`}`, { status })
}

/** One authenticated JSON request. */
async function requestJson(path, token, { fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${API_BASE}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': API_VERSION,
        'user-agent': USER_AGENT,
      },
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
    if (!response.ok) throw apiError(response, body)
    return { body, headers: response.headers }
  } catch (error) {
    if (error instanceof GitHubApiError) throw error
    if (error?.name === 'AbortError') throw new GitHubApiError('连接 GitHub API 超时（检查网络或代理）')
    throw new GitHubApiError(`连不上 GitHub API（${messageOf(error)}）`)
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
