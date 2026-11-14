import test from 'node:test'
import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createAdmin, MAX_DELETE_IDS, spillDirectory } from '../host/chats/lib/admin.js'
import { createdFilesFromEvents, unsafeDirectoryReason } from '../host/chats/lib/cleanup.js'

const exists = (file) => fs.stat(file).then(() => true, () => false)

/** One DSH-shaped tool call plus its result. */
function toolPair(callId, name, args, text) {
  return [
    { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } },
    { type: 'tool/result', seq: 0, time: 0, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] } } },
  ]
}

async function fixture(t, options = {}) {
  /** A workspace with no chat living in it: the only case a folder-only delete applies to. */
  const empty = options.empty === true
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yk-admin-'))
  // 断言一挂也要把临时目录收掉，否则每跑一次失败就漏一个 mkdtemp。
  t.after(() => fs.rm(tmp, { recursive: true, force: true }))
  const ws = path.join(tmp, 'workspace', 'proj1')
  const sessions = path.join(tmp, 'sessions')
  await fs.mkdir(path.join(ws, 'src', 'deep'), { recursive: true })
  await fs.mkdir(sessions, { recursive: true })
  const createdAt = Date.now() - 1000
  const id = 'session-123'
  const artifact = path.join(sessions, 'proj1', id)
  await fs.mkdir(artifact, { recursive: true })
  await fs.writeFile(path.join(artifact, 'session.v3.jsonl.zstd'), 'binary')

  const created = path.join(ws, 'src', 'deep', 'new.txt')
  const createdRelative = path.join(ws, 'notes.md')
  const updated = path.join(ws, 'existing.txt')
  const outside = path.join(tmp, 'outside.txt')
  for (const file of [created, createdRelative, updated, outside]) await fs.writeFile(file, 'x')

  const events = [
    ...toolPair('c1', 'write', { file_path: created, content: 'x' }, 'Created file'),
    ...toolPair('c2', 'str_replace_editor', { command: 'create', path: 'notes.md', file_text: 'x' }, 'File created'),
    ...toolPair('c3', 'write', { file_path: updated, content: 'x' }, 'Updated file'),
    ...toolPair('c4', 'write', { file_path: outside, content: 'x' }, 'Created file'),
  ]
  const header = { id, cwd: ws, createdAt }
  const persistence = {
    root: sessions,
    // 这是后端 list() 真实返回的形状：header / revision / sizeBytes / location，没有事件计数。
    list: async () => (empty ? [] : [{ header, revision: 'rev-1', sizeBytes: 100, location: { path: path.join(artifact, 'session.v3.jsonl.zstd') } }]),
    locate: () => ({ path: path.join(artifact, 'session.v3.jsonl.zstd') }),
    open: async () => ({ read: async () => ({ events }), close: async () => {} }),
  }
  const registry = {
    workspaces: [{ id: 'ws-1', title: 'Proj 1', path: ws, sessionIds: [id], detachSession: async () => {} }],
    list() {
      return this.workspaces
    },
    deleted: [],
    async delete(wsId) {
      this.deleted.push(wsId)
    },
    unarchiveSession: async () => {},
    unpinSession: async () => {},
  }
  /** Everything the delete did to the process, in order. */
  const calls = []
  const artifactAtDetach = []
  const emitted = []
  const projectionDeleted = []
  const live = new Set(options.live ?? [])
  const sessionQuery = {
    listSessions: async () => (empty ? [] : [{ header, live: live.has(id) }]),
    titleReads: [],
    async readTitleSnapshots(ids) {
      sessionQuery.titleReads.push(ids)
      return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: {} }))
    },
  }
  const ctx = {
    sessionQuery,
    sessionPersistence: persistence,
    workspaceRegistry: registry,
    sessions: {
      get: (sessionId) => (live.has(sessionId) ? { id: sessionId } : undefined),
      flush: async (session) => {
        calls.push(`flush:${session.id}`)
      },
      liveEntryFor: (session) => ({ id: session.id }),
      detachEntered: (entry) => {
        calls.push(`detach:${entry.id}`)
        artifactAtDetach.push({ id: entry.id, exists: fsSync.existsSync(path.join(sessions, 'proj1', entry.id)) })
      },
    },
    emit: (event, sessionId) => {
      calls.push(`emit:${event}:${sessionId}`)
      emitted.push({ event, id: sessionId, artifactExists: fsSync.existsSync(path.join(sessions, 'proj1', sessionId)) })
    },
    waterfall: options.waterfall ?? (async () => []),
    sessionProjectionCache: {
      cachedSnapshot: () => undefined,
      requireTable: () => ({ delete: async (sessionId) => projectionDeleted.push(sessionId) }),
    },
  }
  const admin = createAdmin({ ctx, config: { sessionsRoot: sessions, ...(options.config ?? {}) }, ...(options.fs === undefined ? {} : { fs: options.fs }) })
  return {
    tmp, ws, artifact, admin, registry, persistence, header, created, createdRelative, updated, outside, events,
    ctx, sessions, calls, artifactAtDetach, emitted, projectionDeleted, sessionQuery, live,
  }
}

test('a deleted loaded chat is flushed, detached and announced before its artifact goes', async (t) => {
  const f = await fixture(t, { live: ['session-123'] })
  const res = await f.admin.remove({ ids: ['session-123'] })
  assert.equal(res.deleted, 1)
  assert.deepEqual(res.failed, [])
  assert.deepEqual(f.calls, [
    'flush:session-123',
    'detach:session-123',
    'emit:api-session/removed:session-123',
  ])
  // 分离发生在删除之前：此刻工件还在，写的还是自己的文件。
  assert.deepEqual(f.artifactAtDetach, [{ id: 'session-123', exists: true }])
  assert.deepEqual(f.emitted, [{ event: 'api-session/removed', id: 'session-123', artifactExists: false }])
  assert.deepEqual(f.projectionDeleted, ['session-123'], '投影缓存行一并清掉')
  assert.equal(await exists(f.artifact), false, 'the artifact is removed')
  assert.deepEqual(res.state.sessions.map((row) => row.id), [])
})

test('a loaded chat with no artifact yet leaves the listing and the store', async (t) => {
  const f = await fixture(t)
  const header = { id: 'session-new', cwd: f.ws, createdAt: Date.now() }
  f.live.add('session-new')
  f.ctx.sessionQuery.listSessions = async () => [{ header, live: true }]
  f.ctx.sessionPersistence = { root: f.sessions }
  const admin = createAdmin({ ctx: f.ctx, config: { sessionsRoot: f.sessions } })
  const res = await admin.remove({ ids: ['session-new'] })
  assert.equal(res.deleted, 1, 'nothing on disk to remove, but the row still goes')
  assert.deepEqual(f.calls, ['flush:session-new', 'detach:session-new', 'emit:api-session/removed:session-new'])
  assert.deepEqual(res.state.sessions.map((row) => row.id), [])
})

test('the delete asks the host activity waterfall, not the agent status', async (t) => {
  const f = await fixture(t, { live: ['session-123'], waterfall: async () => [{ kind: 'subagent' }] })
  f.ctx.agents = { get: () => ({ status: 'idle' }) }
  const res = await f.admin.remove({ ids: ['session-123'] })
  assert.equal(res.deleted, 0)
  assert.deepEqual(res.failed, [{ id: 'session-123', reason: 'running' }])
  assert.equal(await exists(f.artifact), true, 'the log survives while the host reports work')
  assert.deepEqual(f.calls, [], 'nothing is flushed or detached')
})

test('a chat whose turn is still running stays on disk', async (t) => {
  const f = await fixture(t, { live: ['session-123'], waterfall: async () => [{ kind: 'turn' }] })
  const res = await f.admin.remove({ ids: ['session-123'] })
  assert.equal(res.deleted, 0)
  assert.deepEqual(res.failed, [{ id: 'session-123', reason: 'running' }])
  assert.equal(await exists(f.artifact), true, 'the log survives while a turn is writing to it')
})

test('createdFilesFromEvents keeps only files a file tool reported creating', () => {
  const events = [
    ...toolPair('a', 'write', { file_path: '/w/a.txt' }, 'Created file'),
    ...toolPair('b', 'write', { file_path: '/w/b.txt' }, 'Updated file'),
    ...toolPair('c', 'str_replace_editor', { command: 'create', path: '/w/c.txt' }, 'ok'),
    ...toolPair('d', 'str_replace_editor', { command: 'str_replace', path: '/w/d.txt' }, 'ok'),
    { type: 'tool/call', data: { callId: 'e', name: 'write', arguments: '{"file_path":"/w/e.txt"}' } },
  ]
  assert.deepEqual(createdFilesFromEvents(events, '/w'), [path.resolve('/w/a.txt'), path.resolve('/w/c.txt')])
})

test('delete with deleteFiles removes created files only, inside the workspace', async (t) => {
  const f = await fixture(t)
  const res = await f.admin.remove({ ids: ['session-123'], deleteFiles: true })
  assert.equal(res.deleted, 1)
  assert.equal(res.filesDeleted, 2)
  assert.equal(await exists(f.created), false)
  assert.equal(await exists(f.createdRelative), false)
  assert.equal(await exists(path.join(f.ws, 'src')), false, 'emptied directories are pruned')
  assert.equal(await exists(f.updated), true, 'an overwritten file stays')
  assert.equal(await exists(f.outside), true, 'a file outside the workspace stays')
  assert.equal(await exists(f.artifact), false)
  assert.equal(await exists(f.ws), true, 'the workspace itself stays')
})

test('workspace delete removes the registered directory and its registration', async (t) => {
  const f = await fixture(t)
  const res = await f.admin.remove({ ids: ['session-123'], deleteWorkspaceDir: true, workspaceId: 'ws-1' })
  assert.equal(res.deleted, 1)
  assert.equal(res.workspaceDirDeleted, true)
  assert.equal(await exists(f.ws), false)
  assert.equal(await exists(f.outside), true)
  assert.deepEqual(f.registry.deleted, ['ws-1'])
  // The success flag already reports this, so no prose note repeats it.
  assert.deepEqual(res.notes, [])
})

test('workspace delete without the folder keeps the directory but drops the registration', async (t) => {
  const f = await fixture(t)
  const res = await f.admin.remove({ ids: ['session-123'], deleteWorkspace: true, workspaceId: 'ws-1' })
  assert.equal(res.workspaceDirDeleted, false)
  assert.equal(res.workspaceRemoved, true)
  assert.equal(await exists(f.ws), true)
  assert.deepEqual(f.registry.deleted, ['ws-1'])
})

test('an empty registered workspace can be deleted with its folder', async (t) => {
  const f = await fixture(t, { empty: true })
  const res = await f.admin.remove({ ids: [], deleteWorkspaceDir: true, workspaceId: 'ws-1' })
  assert.equal(res.workspaceDirDeleted, true)
  assert.equal(await exists(f.ws), false)
})

test('workspace delete refuses a path that is neither registered nor a chat cwd', async (t) => {
  const f = await fixture(t)
  await assert.rejects(() => f.admin.remove({ ids: [], deleteWorkspaceDir: true, workspacePath: f.tmp }), /找不到要删除的工作区/)
  assert.equal(await exists(f.tmp), true)
})

test('unsafeDirectoryReason protects system directories and their ancestors', () => {
  assert.notEqual(unsafeDirectoryReason('/'), null)
  assert.notEqual(unsafeDirectoryReason('/etc'), null)
  assert.notEqual(unsafeDirectoryReason('/data'), null)
  assert.notEqual(unsafeDirectoryReason(os.homedir()), null)
  assert.notEqual(unsafeDirectoryReason(path.dirname(os.homedir())), null)
  assert.equal(unsafeDirectoryReason(path.join(os.tmpdir(), 'yk-some-project')), null)
})

test('a folder delete is refused while chats in it were not selected', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    () => f.admin.remove({ ids: [], deleteWorkspaceDir: true, workspaceId: 'ws-1' }),
    /未选中/,
  )
  assert.equal(await exists(f.ws), true, 'the folder survives')
})

test('the folder guard compares real paths, so a symlinked cwd still counts as selected elsewhere', async (t) => {
  const f = await fixture(t)
  const link = path.join(f.tmp, 'ws-link')
  await fs.symlink(f.ws, link, 'dir')
  // 未选中的会话用符号链接写法登记 cwd；字符串比较会把它算成不在这个目录里。
  const other = { id: 'session-other', cwd: link, createdAt: Date.now() }
  const ctx = {
    ...f.ctx,
    sessionQuery: { listSessions: async () => [{ header: f.header, live: false }, { header: other, live: false }] },
    sessionPersistence: { root: f.sessions, list: async () => [] },
    workspaceRegistry: { list: () => [{ id: 'ws-1', title: 'Proj 1', path: f.ws, sessionIds: ['session-123', 'session-other'] }] },
  }
  const admin = createAdmin({ ctx, config: { sessionsRoot: f.sessions } })
  await assert.rejects(() => admin.remove({ ids: ['session-123'], deleteWorkspaceDir: true, workspaceId: 'ws-1' }), /未选中/)
  assert.equal(await exists(f.ws), true, 'the real directory survives')
  assert.equal(fsSync.existsSync(link), true)
})

test('a delete request above the id limit is refused instead of truncated', async (t) => {
  const f = await fixture(t)
  const ids = Array.from({ length: MAX_DELETE_IDS + 1 }, (_, index) => `missing-${index}`)
  await assert.rejects(() => f.admin.remove({ ids }), new RegExp(`一次最多删除 ${MAX_DELETE_IDS} 个`))
})

test('snapshot: a chat is listed as stored and dated from its artifact', async (t) => {
  const f = await fixture(t)
  const state = await f.admin.snapshot()
  assert.equal(state.sessions.length, 1)
  const [row] = state.sessions
  assert.equal(row.stored, true)
  assert.equal(row.workspaceId, 'ws-1')
  assert.equal(row.bytes, 100)
  // 后端快照里没有事件计数，行里也不该凭空多一个 0。
  assert.equal('events' in row, false)
  // The artifact file was written just now, so activity cannot precede creation.
  assert.ok(row.updatedAt >= row.createdAt)
})

test('the totals count top-level chats, not the subagent chats nested under them', async (t) => {
  const f = await fixture(t)
  const headers = [
    { id: 'parent', cwd: f.ws, createdAt: 3 },
    { id: 'child', cwd: f.ws, createdAt: 2, origin: 'subagent', parentSession: 'parent' },
    { id: 'other', cwd: f.ws, createdAt: 1 },
  ]
  f.ctx.sessionQuery.listSessions = async () => headers.map((header) => ({ header, live: false }))
  f.ctx.sessionPersistence = { root: f.sessions }
  const admin = createAdmin({ ctx: f.ctx, config: { sessionsRoot: f.sessions } })
  const state = await admin.snapshot()
  // 子会话仍然在列表里（删除要级联），但计数按界面上的一级会话算。
  assert.deepEqual(state.sessions.map((row) => row.id), ['parent', 'child', 'other'])
  assert.equal(state.totals.all, 2)
  assert.equal(state.totals.active, 2)
  assert.equal(state.totals.archived, 0)
  assert.equal(state.totals.bytes, 0)
})

test('the listing hands the panel only real subagent parentage', async (t) => {
  const f = await fixture(t)
  const parent = { id: 'parent', cwd: f.ws, createdAt: 1 }
  const subagent = { id: 'child', cwd: f.ws, createdAt: 2, origin: 'subagent', parentSession: 'parent' }
  // 历史 fork：parentSession 指向源会话，但它不是子智能体，不能被级联删除。
  const fork = { id: 'fork', cwd: f.ws, createdAt: 3, parentSession: 'parent' }
  f.ctx.sessionQuery.listSessions = async () => [parent, subagent, fork].map((header) => ({ header, live: false }))
  const admin = createAdmin({ ctx: f.ctx, config: { sessionsRoot: f.sessions } })
  const state = await admin.snapshot()
  const byId = new Map(state.sessions.map((row) => [row.id, row]))
  assert.equal(byId.get('child').parentSession, 'parent')
  assert.equal(byId.get('fork').parentSession, null)
  assert.equal(byId.get('fork').origin, null)
})

test('a cyclic parent pair is cut and reported instead of recursing forever', async (t) => {
  const f = await fixture(t)
  const one = { id: 'one', cwd: f.ws, createdAt: 1, origin: 'subagent', parentSession: 'two' }
  const two = { id: 'two', cwd: f.ws, createdAt: 2, origin: 'subagent', parentSession: 'one' }
  f.ctx.sessionQuery.listSessions = async () => [one, two].map((header) => ({ header, live: false }))
  const admin = createAdmin({ ctx: f.ctx, config: { sessionsRoot: f.sessions } })
  const state = await admin.snapshot()
  const rooted = state.sessions.filter((row) => row.parentSession === null)
  assert.equal(rooted.length, 1, 'one of the two links is cut so the panel has a root')
  assert.ok(state.warnings.some((warning) => warning.includes('环')))
})

test('deleting a parent takes its subagent chats, never a fork branch', async (t) => {
  const f = await fixture(t)
  const dirs = new Map()
  const headers = [
    { id: 'parent', cwd: f.ws, createdAt: 1 },
    { id: 'child', cwd: f.ws, createdAt: 2, origin: 'subagent', parentSession: 'parent' },
    { id: 'fork', cwd: f.ws, createdAt: 3, parentSession: 'parent' },
  ]
  for (const header of headers) {
    const directory = path.join(f.sessions, 'proj1', header.id)
    dirs.set(header.id, directory)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'session.v3.jsonl.zstd'), 'binary')
  }
  f.ctx.sessionQuery.listSessions = async () => headers.map((header) => ({ header, live: false }))
  f.ctx.sessionPersistence = {
    root: f.sessions,
    list: async () => [],
    locate: ({ id }) => (dirs.has(id) ? { path: path.join(dirs.get(id), 'session.v3.jsonl.zstd') } : null),
  }
  const admin = createAdmin({ ctx: f.ctx, config: { sessionsRoot: f.sessions } })
  const res = await admin.remove({ ids: ['parent'] })
  assert.deepEqual([...res.ids].sort(), ['child', 'parent'])
  assert.equal(await exists(dirs.get('parent')), false)
  assert.equal(await exists(dirs.get('child')), false)
  assert.equal(await exists(dirs.get('fork')), true, 'the fork branch is an independent chat')
})

test('a lineage deeper than the cap is refused, not walked', async (t) => {
  const f = await fixture(t)
  const headers = []
  for (let index = 0; index < 70; index += 1) {
    headers.push({
      id: `s${index}`,
      cwd: f.ws,
      createdAt: index,
      origin: 'subagent',
      ...(index === 0 ? {} : { parentSession: `s${index - 1}` }),
    })
  }
  f.ctx.sessionQuery.listSessions = async () => headers.map((header) => ({ header, live: false }))
  f.ctx.sessionPersistence = { root: f.sessions, list: async () => [] }
  const admin = createAdmin({ ctx: f.ctx, config: { sessionsRoot: f.sessions } })
  await assert.rejects(() => admin.remove({ ids: ['s0'] }), /64 层/)
})

test('titles are remembered per log revision, so the budget advances through the list', async (t) => {
  const f = await fixture(t)
  const headers = ['a', 'b', 'c'].map((id, index) => ({ id, cwd: f.ws, createdAt: index + 1 }))
  f.ctx.sessionQuery.listSessions = async () => headers.map((header) => ({ header, live: false }))
  f.ctx.sessionQuery.readTitleSnapshots = async (ids) => {
    f.sessionQuery.titleReads.push(ids)
    return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: { title: `T-${sessionId}` } } }))
  }
  f.ctx.sessionPersistence = {
    root: f.sessions,
    list: async () => headers.map((header) => ({ header, revision: 'rev-1', sizeBytes: 1 })),
  }
  const admin = createAdmin({ ctx: f.ctx, config: { sessionsRoot: f.sessions, titleBudget: 1 } })
  await admin.snapshot()
  await admin.snapshot()
  const state = await admin.snapshot()
  assert.deepEqual(f.sessionQuery.titleReads, [['a'], ['b'], ['c']])
  assert.deepEqual(state.sessions.map((row) => row.title).sort(), ['T-a', 'T-b', 'T-c'])
  // 日志换了一代才重新读。
  f.ctx.sessionPersistence.list = async () => headers.map((header) => ({ header, revision: 'rev-2', sizeBytes: 1 }))
  await admin.snapshot()
  assert.equal(f.sessionQuery.titleReads.length, 4)
})

test('a delete clears the projection row and the spill directory', async (t) => {
  const f = await fixture(t)
  const spillRoot = path.join(f.tmp, 'spill')
  const spill = spillDirectory(spillRoot, 'session-123')
  await fs.mkdir(spill, { recursive: true })
  await fs.writeFile(path.join(spill, 'tool-output.txt'), 'x')
  f.ctx.spillStore = { root: spillRoot }
  const res = await f.admin.remove({ ids: ['session-123'] })
  assert.equal(res.deleted, 1)
  assert.deepEqual(f.projectionDeleted, ['session-123'])
  assert.equal(await exists(spill), false)
})

test('a spill directory that cannot be removed is only a warning', async (t) => {
  const f = await fixture(t)
  const spillRoot = path.join(f.tmp, 'spill')
  const spill = spillDirectory(spillRoot, 'session-123')
  await fs.mkdir(spill, { recursive: true })
  f.ctx.spillStore = { root: spillRoot }
  const guarded = {
    ...fs,
    rm: async (target, options) => {
      if (target === spill) throw new Error('EACCES: permission denied')
      return fs.rm(target, options)
    },
  }
  const admin = createAdmin({ ctx: f.ctx, config: { sessionsRoot: f.sessions }, fs: guarded })
  const res = await admin.remove({ ids: ['session-123'] })
  assert.equal(res.deleted, 1, '工件本身删掉了')
  assert.equal(await exists(f.artifact), false)
  assert.ok(res.notes.some((note) => note.includes('临时转储目录未清理')), res.notes.join('\n'))
})

test('archive finds workspaceRegistry per call, not when the row loads', async () => {
  // The workspace row initializes after this one; capturing the service at load
  // time left archiving broken for the whole process.
  const archived = new Set()
  const registry = {
    get archivedSessionIds() { return [...archived] },
    async archiveSession(id) { archived.add(id) },
    async unarchiveSession(id) { archived.delete(id) },
  }
  const ctx = { sessionQuery: { listSessions: async () => [] }, waterfall: async () => [] }
  const admin = createAdmin({ ctx, config: {} })
  assert.equal((await admin.snapshot()).canArchive, false)
  ctx.workspaceRegistry = registry
  const result = await admin.setArchived({ id: 's1', archived: true })
  assert.equal(result.archived, true)
  assert.deepEqual([...archived], ['s1'])
  assert.equal((await admin.snapshot()).canArchive, true)
})

test('archiving asks the activity waterfall and only stops work when asked', async () => {
  const archivedCalls = []
  const registry = {
    get archivedSessionIds() { return [] },
    async archiveSession(id, options) { archivedCalls.push([id, options]) },
    async unarchiveSession() {},
  }
  const ctx = {
    sessionQuery: { listSessions: async () => [] },
    workspaceRegistry: registry,
    waterfall: async () => [{ kind: 'turn' }],
  }
  const admin = createAdmin({ ctx, config: {} })
  await assert.rejects(admin.setArchived({ id: 's1', archived: true }), /仍有未结束的工作/)
  assert.deepEqual(archivedCalls, [], '宿主文案不再原样透出，也没有先写归档集合')
  const result = await admin.setArchived({ id: 's1', archived: true, stopActivity: true })
  assert.equal(result.archived, true)
  assert.deepEqual(archivedCalls, [['s1', { stopActivity: true }]])
})

test('a composition without the registry says so instead of pretending to archive', async () => {
  const admin = createAdmin({ ctx: { sessionQuery: { listSessions: async () => [] } }, config: {} })
  const snapshot = await admin.snapshot()
  assert.equal(snapshot.canArchive, false)
  await assert.rejects(admin.setArchived({ id: 's1', archived: true }), /未提供归档能力/)
})
