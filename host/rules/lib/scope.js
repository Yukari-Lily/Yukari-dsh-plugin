/**
 * Which constraints apply to one assembly.
 *
 * A session's project is resolved without touching the filesystem for the
 * registry: the workspace it was attached to wins, then the longest registered
 * workspace containing its cwd, then the first ancestor carrying `.git`, then
 * the cwd itself.
 * @module yukari-dsh-plugin/rules/scope
 */
import path from 'node:path'
import { findProjectRoot, isInside, workspaceFile } from './paths.js'

/** The session behind an assembly context. */
export function sessionOf(context) {
  return context?.agent?.session ?? context?.session ?? null
}

/** A service from the plugin context, tolerating a composition without it. */
export function serviceOf(ctx, name) {
  try {
    const scoped = typeof ctx.get === 'function' ? ctx.get(name) : null
    if (scoped) return scoped
  } catch {
    /* the service is not ready in this composition */
  }
  try {
    const direct = ctx[name]
    if (direct) return direct
  } catch {
    /* a proxy without the service throws on property access */
  }
  return null
}

/**
 * Registered workspaces, or the process cwd when the composition has none.
 * @param ctx - plugin context.
 * @returns `[{ id, title, path, sessionIds }]`.
 */
export function workspaceList(ctx) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  const list = []
  const seen = new Set()
  try {
    for (const workspace of registry?.list?.() ?? []) {
      if (workspace === null || typeof workspace !== 'object') continue
      if (typeof workspace.path !== 'string' || workspace.path === '') continue
      const resolved = path.resolve(workspace.path)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      list.push({
        id: workspace.id === undefined ? resolved : String(workspace.id),
        title: typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : path.basename(resolved) || resolved,
        path: resolved,
        sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
      })
    }
  } catch {
    /* not every composition has a registry */
  }
  if (list.length === 0) {
    const cwd = path.resolve(process.cwd())
    list.push({ id: cwd, title: path.basename(cwd) || cwd, path: cwd, sessionIds: [] })
  }
  return list
}

/**
 * The workspace a session belongs to.
 * @param list - `workspaceList()` output.
 * @param sessionId - session identity, when known.
 * @param cwd - session directory, when known.
 * @returns the matching workspace, or null.
 */
export function workspaceFor(list, sessionId, cwd) {
  const raw = sessionId === undefined || sessionId === null ? '' : sessionId
  const id = typeof raw === 'string' ? raw : String(raw)
  if (id !== '') {
    for (const workspace of list) if (workspace.sessionIds.includes(id)) return workspace
  }
  if (typeof cwd !== 'string' || cwd === '') return null
  const resolved = path.resolve(cwd)
  let best = null
  for (const workspace of list) {
    if (!isInside(workspace.path, resolved)) continue
    if (best === null || workspace.path.length > best.path.length) best = workspace
  }
  return best
}

/**
 * The effective working directory of one session, synchronously.
 * @returns an absolute path, or null when the session has none.
 */
export function sessionCwd(ctx, session) {
  if (session === null || typeof session !== 'object') return null
  const service = serviceOf(ctx, 'workingDirectory')
  try {
    const value = service?.get?.(session)
    if (typeof value === 'string' && value !== '') return path.resolve(value)
  } catch {
    /* fall through to the recorded values */
  }
  const projected = session.projectionValues?.workingDirectory
  if (typeof projected === 'string' && projected !== '') return path.resolve(projected)
  const header = session.header?.cwd
  if (typeof header === 'string' && header !== '') return path.resolve(header)
  return null
}

/**
 * Everything the prompt and the panel need to know about one session's scope.
 * @returns `{ cwd, workspace, projectRoot, source, file }`; projectRoot/file are
 * null when no cwd is known (the global constraint still applies).
 */
export function resolveScope(ctx, session) {
  const cwd = sessionCwd(ctx, session)
  const list = workspaceList(ctx)
  const workspace = cwd === null ? null : workspaceFor(list, session?.id, cwd)
  if (workspace !== null) {
    return { cwd, workspace, projectRoot: workspace.path, source: 'workspace', file: workspaceFile(workspace.path) }
  }
  if (cwd === null) return { cwd: null, workspace: null, projectRoot: null, source: 'none', file: null }
  const root = findProjectRoot(cwd)
  const source = root === cwd ? 'cwd' : 'project'
  return { cwd, workspace: null, projectRoot: root, source, file: workspaceFile(root) }
}
