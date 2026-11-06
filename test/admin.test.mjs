import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createAdmin } from '../host/chats/lib/admin.js'
import { createdFilesFromEvents, unsafeDirectoryReason } from '../host/chats/lib/cleanup.js'

const exists = (file) => fs.stat(file).then(() => true, () => false)

/** One DSH-shaped tool call plus its result. */
function toolPair(callId, name, args, text) {
  return [
    { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } },
    { type: 'tool/result', seq: 0, time: 0, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] } } },
  ]
}

async function fixture(options = {}) {
  /** A workspace with no chat living in it: the only case a folder-only delete applies to. */
  const empty = options.empty === true
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yk-admin-'))
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
    list: async () => (empty ? [] : [{ header, sizeBytes: 100, eventCount: events.length, location: { path: path.join(artifact, 'session.v3.jsonl.zstd') } }]),
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
  const ctx = {
    sessionQuery: { listSessions: async () => (empty ? [] : [{ header, live: false }]) },
    sessionPersistence: persistence,
    workspaceRegistry: registry,
  }
  const admin = createAdmin({ ctx, config: { sessionsRoot: sessions } })
  return { tmp, ws, artifact, admin, registry, created, createdRelative, updated, outside, events }
}

test('a chat loaded in this process is refused, even when files are gone', async () => {
  const f = await fixture()
  const loaded = { ...f.admin }
  // A store that knows this chat: the same condition the Host uses for "已加载".
  const ctx = {
    sessionQuery: { listSessions: async () => [{ header: { id: 'session-123', cwd: f.ws, createdAt: Date.now() }, live: true }] },
    sessionPersistence: { root: path.dirname(path.dirname(f.artifact)) },
    sessions: { get: (id) => (id === 'session-123' ? { id } : undefined) },
    workspaceRegistry: { list: () => [], unarchiveSession: async () => {}, unpinSession: async () => {} },
  }
  const admin = createAdmin({ ctx, config: { sessionsRoot: path.dirname(path.dirname(f.artifact)) } })
  const res = await admin.remove({ ids: ['session-123'] })
  assert.equal(res.deleted, 0)
  assert.deepEqual(res.failed, [{ id: 'session-123', reason: 'live' }])
  assert.equal(await exists(f.artifact), true, 'the artifact survives a refused delete')
  await fs.rm(f.tmp, { recursive: true, force: true })
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

test('delete with deleteFiles removes created files only, inside the workspace', async () => {
  const f = await fixture()
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
  await fs.rm(f.tmp, { recursive: true, force: true })
})

test('workspace delete removes the registered directory and its registration', async () => {
  const f = await fixture()
  const res = await f.admin.remove({ ids: ['session-123'], deleteWorkspaceDir: true, workspaceId: 'ws-1' })
  assert.equal(res.deleted, 1)
  assert.equal(res.workspaceDirDeleted, true)
  assert.equal(await exists(f.ws), false)
  assert.equal(await exists(f.outside), true)
  assert.deepEqual(f.registry.deleted, ['ws-1'])
  // The success flag already reports this, so no prose note repeats it.
  assert.deepEqual(res.notes, [])
  await fs.rm(f.tmp, { recursive: true, force: true })
})

test('workspace delete without the folder keeps the directory but drops the registration', async () => {
  const f = await fixture()
  const res = await f.admin.remove({ ids: ['session-123'], deleteWorkspace: true, workspaceId: 'ws-1' })
  assert.equal(res.workspaceDirDeleted, false)
  assert.equal(res.workspaceRemoved, true)
  assert.equal(await exists(f.ws), true)
  assert.deepEqual(f.registry.deleted, ['ws-1'])
  await fs.rm(f.tmp, { recursive: true, force: true })
})

test('an empty registered workspace can be deleted with its folder', async () => {
  const f = await fixture({ empty: true })
  const res = await f.admin.remove({ ids: [], deleteWorkspaceDir: true, workspaceId: 'ws-1' })
  assert.equal(res.workspaceDirDeleted, true)
  assert.equal(await exists(f.ws), false)
  await fs.rm(f.tmp, { recursive: true, force: true })
})

test('workspace delete refuses a path that is neither registered nor a chat cwd', async () => {
  const f = await fixture()
  await assert.rejects(() => f.admin.remove({ ids: [], deleteWorkspaceDir: true, workspacePath: f.tmp }), /找不到要删除的工作区/)
  assert.equal(await exists(f.tmp), true)
  await fs.rm(f.tmp, { recursive: true, force: true })
})

test('unsafeDirectoryReason protects system directories and their ancestors', () => {
  assert.notEqual(unsafeDirectoryReason('/'), null)
  assert.notEqual(unsafeDirectoryReason('/etc'), null)
  assert.notEqual(unsafeDirectoryReason('/data'), null)
  assert.notEqual(unsafeDirectoryReason(os.homedir()), null)
  assert.notEqual(unsafeDirectoryReason(path.dirname(os.homedir())), null)
  assert.equal(unsafeDirectoryReason(path.join(os.tmpdir(), 'yk-some-project')), null)
})

test('a folder delete is refused while chats in it were not selected', async () => {
  const f = await fixture()
  await assert.rejects(
    () => f.admin.remove({ ids: [], deleteWorkspaceDir: true, workspaceId: 'ws-1' }),
    /没被选中/,
  )
  assert.equal(await exists(f.ws), true, 'the folder survives')
  await fs.rm(f.tmp, { recursive: true, force: true })
})

test('snapshot: a chat is listed as stored and dated from its artifact', async () => {
  const f = await fixture()
  const state = await f.admin.snapshot()
  assert.equal(state.sessions.length, 1)
  const [row] = state.sessions
  assert.equal(row.stored, true)
  assert.equal(row.workspaceId, 'ws-1')
  assert.equal(row.bytes, 100)
  assert.equal(row.events, f.events.length)
  // The artifact file was written just now, so activity cannot precede creation.
  assert.ok(row.updatedAt >= row.createdAt)
  await fs.rm(f.tmp, { recursive: true, force: true })
})
