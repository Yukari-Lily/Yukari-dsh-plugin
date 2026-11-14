import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MARKER_SOURCE_KIND, MARKER_TEXT, markerData, markerOptions } from '../host/rewind/lib/marker.js'
import { cutsOf, planCut, surfaceNodes } from '../host/rewind/lib/surface.js'
import { createSnapshotStore } from '../host/rewind/lib/store.js'
import { createRewind } from '../host/rewind/lib/controller.js'

/** 一条按顺序追加的 surface 事件。 */
const appended = (seq, type = 'user/message', text = `m${seq}`, source = { kind: 'user' }) => ({
  seq,
  type,
  data: {
    content: [{ type: 'text', text }],
    ...(type === 'user/message' ? { source, role: 'user' } : {}),
  },
  surfaceOp: 'append',
})

/** 一条带替换区间的事件。 */
const replacement = (seq, startSeq, endSeq, type = 'user/message', text = MARKER_TEXT, source = { kind: 'rewind-marker' }) => ({
  seq,
  type,
  data: { content: [{ type: 'text', text }], source, role: 'user' },
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: Array.from({ length: endSeq - startSeq + 1 }, (_, index) => startSeq + index),
})

/** 一条只进日志、不进 surface 的事件。 */
const logOnly = (seq, type = 'tool/call') => ({ seq, type, data: {} })

test('surfaceNodes folds appends, replacements and log-only events', () => {
  const events = [
    appended(0, 'system/message'),
    appended(1),
    logOnly(2),
    appended(3, 'assistant/message'),
    appended(4),
    replacement(5, 4, 4),
    appended(6, 'assistant/message'),
  ]
  assert.deepEqual(surfaceNodes(events), [0, 1, 3, 5, 6])
})

test('surfaceNodes replaces a whole range with one node', () => {
  const events = [
    appended(0, 'system/message'),
    appended(1),
    appended(2, 'assistant/message'),
    appended(3, 'tool/result'),
    appended(4),
    replacement(5, 1, 4),
    appended(6, 'assistant/message'),
  ]
  assert.deepEqual(surfaceNodes(events), [0, 5, 6])
})

test('surfaceNodes ignores a replacement whose range left the surface', () => {
  const events = [appended(0, 'system/message'), appended(1), replacement(2, 1, 1), replacement(3, 1, 1)]
  // 3 指向的 1 已经被 2 替换掉，折叠时跳过而不是抛错。
  assert.deepEqual(surfaceNodes(events), [0, 2])
})

test('planCut takes the target and everything after it', () => {
  const events = [
    appended(0, 'system/message'),
    appended(1),
    appended(2, 'assistant/message'),
    appended(3),
    appended(4, 'assistant/message'),
  ]
  assert.deepEqual(planCut(events, 3), { startSeq: 3, endSeq: 4, shadowed: [3, 4] })
  assert.deepEqual(planCut(events, 4), { startSeq: 4, endSeq: 4, shadowed: [4] })
  assert.equal(planCut(events, 9), null)
})

test('cutsOf reads the spans back out of the log', () => {
  const events = [appended(0, 'system/message'), appended(1), appended(2), replacement(3, 2, 2)]
  assert.deepEqual(cutsOf(events), [{ start: 2, target: 2, marker: 3, ids: [] }])
  // 普通用户消息不会被当成标记。
  assert.deepEqual(cutsOf([appended(0, 'system/message'), appended(1)]), [])
})

test('the marker carries a non-empty body, its own source kind and every shadowed seq', () => {
  const data = markerData()
  assert.equal(data.content[0].text, MARKER_TEXT)
  // 标记不能伪装成人类消息，否则它自己也会被当成合法的回撤目标。
  assert.equal(data.source.kind, MARKER_SOURCE_KIND)
  assert.notEqual(MARKER_SOURCE_KIND, 'user')
  const options = markerOptions({ startSeq: 2, endSeq: 3, shadowed: [2, 3] })
  assert.deepEqual(options.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 3 })
  assert.deepEqual(options.sourceEventSeqs, [2, 3])
})

/* ---------------------------------------------------------------- 快照仓库 */

/** 测试里的写入通道：等价于宿主文件系统的原子写，但可以让指定路径失败。 */
function testIo({ deny = new Set() } = {}) {
  const calls = []
  return {
    calls,
    deny,
    async write(target, bytes, signal) {
      calls.push({ op: 'write', target })
      if (deny.has(target)) {
        const error = new Error('文件访问在只读模式下被拒绝。')
        error.code = 'FS_SANDBOX_DENIED'
        throw error
      }
      await fs.writeFile(target, bytes)
      void signal
    },
    async remove(target) {
      calls.push({ op: 'delete', target })
      if (deny.has(target)) {
        const error = new Error('文件访问在只读模式下被拒绝。')
        error.code = 'FS_SANDBOX_DENIED'
        throw error
      }
      await fs.rm(target, { force: true })
    },
  }
}

/** 临时目录里的快照仓库：快照与工作区分开，和真实布局一致。 */
async function storeFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'yk-rewind-'))
  const root = path.join(base, 'store')
  const work = path.join(base, 'work')
  await fs.mkdir(work, { recursive: true })
  const store = createSnapshotStore({ root })
  return { base, root, work, store }
}

const captureFile = (store, work, target, anchorSeq = 5, sessionId = 's1') =>
  store.capture({ sessionId, anchorSeq, workspaceRoot: work, target })

const planFiles = (store, work, seq, sessionId = 's1') => store.planRestore(sessionId, seq, { workspaceRoot: work })

test('a capture restores the bytes that were there before the tool wrote', async () => {
  const { base, work, store } = await storeFixture()
  const file = path.join(work, 'a.txt')
  await fs.writeFile(file, 'before')
  await captureFile(store, work, file)
  await fs.writeFile(file, 'after')
  assert.deepEqual((await planFiles(store, work, 3)).files, [{ path: file, action: 'write' }])
  const result = await store.restore('s1', 3, { workspaceRoot: work, io: testIo() })
  assert.equal(result.restored, 1)
  assert.equal(await fs.readFile(file, 'utf8'), 'before')
  await fs.rm(base, { recursive: true, force: true })
})

test('a file created after the rewind point is deleted again', async () => {
  const { base, work, store } = await storeFixture()
  const file = path.join(work, 'new.txt')
  await captureFile(store, work, file)
  await fs.writeFile(file, 'created')
  assert.deepEqual((await planFiles(store, work, 4)).files, [{ path: file, action: 'delete' }])
  const result = await store.restore('s1', 4, { workspaceRoot: work, io: testIo() })
  assert.equal(result.deleted, 1)
  await assert.rejects(fs.stat(file), /ENOENT/)
  await fs.rm(base, { recursive: true, force: true })
})

test('a rewind with nothing to restore does not need a snapshot directory', async () => {
  const { base, work, store } = await storeFixture()
  // 这条会话一次文件工具都没用过：快照目录不存在。以前这里会去写 journal，
  // 于是 open 一个不存在的目录里的临时文件，把回撤变成 HTTP 500（ENOENT）。
  const result = await store.restore('s1', 8, { workspaceRoot: work, io: testIo() })
  assert.deepEqual(result, { restored: 0, deleted: 0, skipped: [], failed: [], notes: [], journal: null })
  await assert.rejects(fs.stat(path.join(base, 'store', 's1')), /ENOENT/)
  await fs.rm(base, { recursive: true, force: true })
})

test('snapshots at or before the rewind point are left alone', async () => {
  const { base, work, store } = await storeFixture()
  const file = path.join(work, 'b.txt')
  await fs.writeFile(file, 'old')
  await captureFile(store, work, file, 2)
  await fs.writeFile(file, 'new')
  assert.deepEqual((await planFiles(store, work, 3)).files, [])
  const result = await store.restore('s1', 3, { workspaceRoot: work, io: testIo() })
  assert.equal(result.restored, 0)
  assert.equal(await fs.readFile(file, 'utf8'), 'new')
  await fs.rm(base, { recursive: true, force: true })
})

test('capture refuses paths that are not absolute files', async () => {
  const { base, work, store } = await storeFixture()
  assert.deepEqual(await store.capture({ sessionId: 's1', anchorSeq: 1, workspaceRoot: work, target: 'relative.txt' }), {
    skipped: 'relative-path',
  })
  const dir = path.join(work, 'dir')
  await fs.mkdir(dir)
  assert.deepEqual(await captureFile(store, work, dir, 1), { skipped: 'not-a-file' })
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-31: capture never records a path outside the workspace', async () => {
  const { base, work, store } = await storeFixture()
  const outside = path.join(base, 'outside.txt')
  await fs.writeFile(outside, 'secret')

  assert.deepEqual(await captureFile(store, work, outside), { skipped: 'outside-workspace' })
  assert.deepEqual((await planFiles(store, work, 3)).files, [])
  // 跳过原因随预览返回，界面才能如实说明。
  assert.deepEqual((await planFiles(store, work, 3)).skipped, [{ path: outside, reason: 'outside-workspace' }])
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-31: capture refuses symlinks, including one hiding an escape', async () => {
  const { base, work, store } = await storeFixture()
  const outside = path.join(base, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'x.txt'), 'secret')
  await fs.symlink(path.join(outside, 'x.txt'), path.join(work, 'link.txt'))
  await fs.symlink(outside, path.join(work, 'linkdir'))

  assert.deepEqual(await captureFile(store, work, path.join(work, 'link.txt')), { skipped: 'symlink' })
  assert.deepEqual(await captureFile(store, work, path.join(work, 'linkdir', 'x.txt')), { skipped: 'outside-workspace' })
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-31: restore refuses a forged snapshot that points outside the workspace', async () => {
  const { base, work, root, store } = await storeFixture()
  const outside = path.join(base, 'outside.txt')
  await fs.writeFile(outside, 'secret')
  // 旧版本留下的记录里可能有任意绝对路径，还原必须以当前工作区为准重新判定。
  const dir = path.join(root, 's1')
  await fs.mkdir(dir, { recursive: true })
  const payload = { path: outside, root: work, anchorSeq: 5, existed: true, data: Buffer.from('overwritten').toString('base64') }
  await fs.writeFile(path.join(dir, '00000005-0123456789abcdef.json'), JSON.stringify(payload))

  const plan = await planFiles(store, work, 3)
  assert.deepEqual(plan.files, [])
  assert.deepEqual(plan.skipped, [{ path: outside, reason: 'outside-workspace' }])
  const io = testIo()
  await store.restore('s1', 3, { workspaceRoot: work, io })
  assert.deepEqual(io.calls, [])
  assert.equal(await fs.readFile(outside, 'utf8'), 'secret')
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-31: restore refuses a target that turned into a symlink after the capture', async () => {
  const { base, work, store } = await storeFixture()
  const outside = path.join(base, 'outside.txt')
  await fs.writeFile(outside, 'secret')
  const file = path.join(work, 'a.txt')
  await fs.writeFile(file, 'before')
  await captureFile(store, work, file)
  await fs.rm(file)
  await fs.symlink(outside, file)

  const plan = await planFiles(store, work, 3)
  assert.deepEqual(plan.files, [])
  assert.deepEqual(plan.skipped, [{ path: file, reason: 'symlink' }])
  await store.restore('s1', 3, { workspaceRoot: work, io: testIo() })
  assert.equal(await fs.readFile(outside, 'utf8'), 'secret')
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-31: a denied write leaves the file and the snapshots untouched, then rolls back', async () => {
  const { base, work, store } = await storeFixture()
  const file = path.join(work, 'a.txt')
  await fs.writeFile(file, 'before')
  await captureFile(store, work, file)
  await fs.writeFile(file, 'after')

  const io = testIo({ deny: new Set([file]) })
  const result = await store.restore('s1', 3, { workspaceRoot: work, io })
  assert.equal(result.failed.length, 1)
  assert.match(result.failed[0].reason, /只读模式/)
  assert.equal(await fs.readFile(file, 'utf8'), 'after')
  // 失败时快照和 journal 都留着，还能重试或回滚。
  assert.equal((await store.entries('s1')).length, 1)
  await assert.doesNotReject(fs.stat(path.join(base, 'store', 's1', 'restore-00000003.journal.json')))

  io.deny.clear()
  const retried = await store.restore('s1', 3, { workspaceRoot: work, io })
  assert.deepEqual(retried.failed, [])
  assert.equal(retried.restored, 1)
  assert.equal(await fs.readFile(file, 'utf8'), 'before')
  assert.deepEqual(await store.entries('s1'), [])
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-33: the rescue copy restores the state before the restore on rollback', async () => {
  const { base, work, store } = await storeFixture()
  const file = path.join(work, 'a.txt')
  await fs.writeFile(file, 'before')
  await captureFile(store, work, file)
  await fs.writeFile(file, 'after')

  const io = testIo({ deny: new Set([path.join(work, 'other.txt')]) })
  const other = path.join(work, 'other.txt')
  await captureFile(store, work, other)
  await fs.writeFile(other, 'other-after')
  const result = await store.restore('s1', 3, { workspaceRoot: work, io })
  assert.equal(result.failed.length, 1)
  assert.equal(await fs.readFile(file, 'utf8'), 'before', '成功的那份已经写回')

  io.deny.clear()
  const rolled = await store.rollback('s1', 3, { io })
  assert.deepEqual(rolled.failed, [])
  assert.equal(await fs.readFile(file, 'utf8'), 'after', '回滚把写回的文件换回还原前的样子')
  assert.equal(await fs.readFile(other, 'utf8'), 'other-after', '没被还原的文件保持不动')
  // 回滚后 journal 与快照保留，方便核对。
  await assert.doesNotReject(fs.stat(path.join(base, 'store', 's1', 'restore-00000003.journal.json')))
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-33: the rescue copy keeps the relative path inside the snapshot directory', async () => {
  const { base, root, work, store } = await storeFixture()
  const file = path.join(work, 'src', 'deep', 'a.txt')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, 'before')
  await captureFile(store, work, file)
  await fs.writeFile(file, 'after')

  const io = testIo({ deny: new Set([file]) })
  await store.restore('s1', 3, { workspaceRoot: work, io })
  await assert.doesNotReject(fs.stat(path.join(root, 's1', 'rescue', '00000003', 'src', 'deep', 'a.txt')))
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-34: a skipped capture reason is reported by the preview', async () => {
  const { base, work, store } = await storeFixture()
  const big = path.join(work, 'big.bin')
  await fs.writeFile(big, Buffer.alloc(1024 * 1024 + 1, 0x61))
  assert.deepEqual(await captureFile(store, work, big), { skipped: 'too-large' })
  assert.deepEqual((await planFiles(store, work, 3)).skipped, [{ path: big, reason: 'too-large' }])
  assert.deepEqual((await planFiles(store, work, 3)).files, [])
  await fs.rm(base, { recursive: true, force: true })
})

test('SEC-10: the store refuses a session id that is not a single path segment', async () => {
  const { base, store } = await storeFixture()
  for (const sessionId of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'a b']) {
    await assert.rejects(store.entries(sessionId), /未指定会话|会话标识不合法/, `entries rejects ${JSON.stringify(sessionId)}`)
    await assert.rejects(store.capture({ sessionId, anchorSeq: 1, workspaceRoot: base, target: path.join(base, 'x') }), /未指定会话|会话标识不合法/)
    await assert.rejects(store.planRestore(sessionId, 1, { workspaceRoot: base }), /未指定会话|会话标识不合法/)
    await assert.rejects(store.restore(sessionId, 1, { workspaceRoot: base, io: testIo() }), /未指定会话|会话标识不合法/)
  }
  await fs.rm(base, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ 编排 */

/** 一个记录追加事件的假会话。 */
function fakeSession(id, events, header = {}) {
  const live = {
    id,
    seq: events.length,
    header: { id, ...header },
    snapshotEvents: () => events,
    append: (type, data, options) => {
      const event = { seq: events.length, type, time: Date.now(), data, ...options }
      events = [...events, event]
      live.seq = events.length
      return event
    },
  }
  return live
}

/** 记录调用的假宿主文件系统。 */
function fakeHostFs(work, deny = new Set()) {
  const calls = []
  return {
    calls,
    deny,
    async resolve(target) {
      return { targetKey: path.resolve(target), displayPath: target }
    },
    async stat(target) {
      try {
        const info = await fs.stat(target.targetKey)
        return { type: info.isFile() ? 'file' : 'directory' }
      } catch {
        return undefined
      }
    },
    async writeText(target, text) {
      calls.push({ op: 'write', path: target.targetKey })
      if (deny.has(target.targetKey)) {
        const error = new Error('文件访问在只读模式下被拒绝。')
        error.code = 'FS_SANDBOX_DENIED'
        throw error
      }
      await fs.writeFile(target.targetKey, text)
    },
    async deleteFile(target) {
      calls.push({ op: 'delete', path: target.targetKey })
      if (deny.has(target.targetKey)) {
        const error = new Error('文件访问在只读模式下被拒绝。')
        error.code = 'FS_SANDBOX_DENIED'
        throw error
      }
      await fs.rm(target.targetKey, { force: true })
    },
  }
}

/** 回撤编排需要的服务集合。 */
function fakeCtx({ sessions, agents, fsService, workspaceRoot }) {
  const services = {
    sessions,
    agents,
    fs: fsService,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot }) },
    workingDirectory: { ensure: async () => workspaceRoot },
  }
  return { get: (name) => services[name] }
}

test('plan and apply run against a fake session', async () => {
  const { base, work, store } = await storeFixture()
  const live = fakeSession('s1', [appended(0, 'system/message'), appended(1), appended(2, 'assistant/message'), appended(3)], { cwd: work })
  const agents = { get: () => ({ status: 'idle' }) }
  const ctx = fakeCtx({ sessions: { get: (id) => (id === 's1' ? live : undefined) }, agents, fsService: fakeHostFs(work), workspaceRoot: work })
  const rewind = createRewind({ ctx, store })

  const plan = await rewind.plan({ sessionId: 's1', seq: 1 })
  assert.equal(plan.startSeq, 1)
  assert.equal(plan.endSeq, 3)
  assert.equal(plan.tail, 2)
  assert.equal(plan.hidden, 3)
  assert.equal(plan.human, 2, '只有用户自己发的两条算进去')
  assert.equal(typeof plan.planToken, 'string')

  // 只能撤用户消息。
  await assert.rejects(rewind.plan({ sessionId: 's1', seq: 2 }), (error) => {
    assert.equal(error.appCode, 'rewind-target-not-user', 'the panel can translate this rejection')
    return /只能回撤到用户消息/.test(error.message)
  })

  const applied = await rewind.apply({ sessionId: 's1', seq: 1, restoreFiles: false })
  assert.equal(applied.markerSeq, 4)
  assert.equal(live.snapshotEvents()[4].surfaceOp.op, 'replace')
  assert.deepEqual(live.snapshotEvents()[4].sourceEventSeqs, [1, 2, 3])
  // 目标消息也收起了，surface 停在标记上。
  assert.deepEqual(surfaceNodes(live.snapshotEvents()), [0, 4])
  assert.deepEqual(await rewind.cuts('s1'), [{ start: 1, target: 1, marker: 4, ids: [] }])

  await assert.rejects(rewind.plan({ sessionId: 's1', seq: 3 }), /已经不在当前对话里/)
  await fs.rm(base, { recursive: true, force: true })
})

test('apply refuses a session that is not loaded', async () => {
  const { store } = await storeFixture()
  const ctx = { get: () => undefined }
  const rewind = createRewind({ ctx, store })
  await assert.rejects(rewind.apply({ sessionId: 'nope', seq: 1 }), /没有在运行中的 Host 里加载/)
})

test('P1-32: injected messages and the rewind marker are not rewind targets', async () => {
  const { base, work, store } = await storeFixture()
  const events = [
    appended(0, 'system/message'),
    appended(1),
    // 压缩检查点：带替换区间，但来源是 compact-checkpoint。
    { ...replacement(2, 1, 1, 'user/message', 'summary', { kind: 'compact-checkpoint' }) },
    // 运行时上下文注入。
    appended(3, 'user/message', 'runtime context', { kind: 'runtime-context' }),
    // 界面里真实用户消息（user-rpc 的 kind 仍是 user）。
    appended(4, 'user/message', 'real question', { kind: 'user', rpcId: 'r1' }),
    appended(5, 'assistant/message'),
    // 自家标记。
    { ...replacement(6, 5, 5, 'user/message', MARKER_TEXT) },
  ]
  const live = fakeSession('s1', events, { cwd: work })
  const ctx = fakeCtx({
    sessions: { get: (id) => (id === 's1' ? live : undefined) },
    agents: { get: () => ({ status: 'idle' }) },
    fsService: fakeHostFs(work),
    workspaceRoot: work,
  })
  const rewind = createRewind({ ctx, store })

  await assert.rejects(rewind.plan({ sessionId: 's1', seq: 2 }), /注入的上下文与回撤标记不能作为目标/)
  await assert.rejects(rewind.plan({ sessionId: 's1', seq: 3 }), /注入的上下文与回撤标记不能作为目标/)
  await assert.rejects(rewind.plan({ sessionId: 's1', seq: 6 }), /注入的上下文与回撤标记不能作为目标/)
  // 真实用户消息仍然可以。
  const plan = await rewind.plan({ sessionId: 's1', seq: 4 })
  assert.equal(plan.startSeq, 4)
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-34: edit and apply_patch are captured like write', async () => {
  const { base, work, store } = await storeFixture()
  const edited = path.join(work, 'edited.txt')
  const added = path.join(work, 'src', 'added.txt')
  const moved = path.join(work, 'moved.txt')
  const removed = path.join(work, 'removed.txt')
  for (const file of [edited, removed]) await fs.writeFile(file, 'before')
  const live = fakeSession('s1', [appended(0, 'system/message'), appended(1)], { cwd: work })
  const ctx = fakeCtx({ sessions: { get: () => live }, agents: { get: () => ({ status: 'idle' }) }, fsService: fakeHostFs(work), workspaceRoot: work })
  const rewind = createRewind({ ctx, store })
  const exec = (name, args) => ({ name, arguments: args, agent: { session: live } })

  const editReceipts = await rewind.capture(exec('edit', { file_path: edited, old_string: 'before', new_string: 'after' }))
  assert.deepEqual(editReceipts, [{ target: edited, stored: true, existed: true }])

  const patch = [
    '*** Begin Patch',
    `*** Update File: ${edited}`,
    '@@',
    '-before',
    '+after',
    `*** Add File: ${path.relative(work, added)}`,
    '+created',
    `*** Move to: ${path.relative(work, moved)}`,
    `*** Delete File: ${removed}`,
    '*** End Patch',
  ].join('\n')
  const patchReceipts = await rewind.capture(exec('apply_patch', { input: patch }))
  assert.deepEqual(
    patchReceipts.map((receipt) => receipt.target),
    [edited, added, moved, removed],
  )
  assert.ok(patchReceipts.every((receipt) => receipt.stored === true))

  // 现在把文件改成"工具写过之后"的样子，回撤必须能把四种改动都退回去。
  await fs.writeFile(edited, 'after')
  await fs.mkdir(path.dirname(added), { recursive: true })
  await fs.writeFile(added, 'created')
  await fs.writeFile(moved, 'created')
  await fs.rm(removed)
  const plan = await rewind.plan({ sessionId: 's1', seq: 1 })
  assert.deepEqual(
    plan.files.map((file) => [path.basename(file.path), file.action]).sort(),
    [['added.txt', 'delete'], ['edited.txt', 'write'], ['moved.txt', 'delete'], ['removed.txt', 'write']].sort(),
  )
  const applied = await rewind.apply({ sessionId: 's1', seq: 1, restoreFiles: true })
  assert.equal(applied.restored, 2)
  assert.equal(applied.deleted, 2)
  assert.equal(await fs.readFile(edited, 'utf8'), 'before')
  assert.equal(await fs.readFile(removed, 'utf8'), 'before')
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-34: a failed capture whose file never appeared is dropped instead of deleting later', async () => {
  const { base, work, store } = await storeFixture()
  const phantom = path.join(work, 'phantom.txt')
  const live = fakeSession('s1', [appended(0, 'system/message'), appended(1)], { cwd: work })
  const ctx = fakeCtx({ sessions: { get: () => live }, agents: { get: () => ({ status: 'idle' }) }, fsService: fakeHostFs(work), workspaceRoot: work })
  const rewind = createRewind({ ctx, store })
  const exec = (name, args) => ({ name, arguments: args, agent: { session: live } })

  const receipts = await rewind.capture(exec('write', { file_path: phantom, content: 'x' }))
  assert.deepEqual(receipts, [{ target: phantom, stored: true, existed: false }])
  await rewind.confirm(exec('write', { file_path: phantom, content: 'x' }), receipts, { isError: true })
  assert.deepEqual(await store.entries('s1'), [])
  // 之后同名的真实文件出现在工作区里，也不会被回撤删掉。
  await fs.writeFile(phantom, 'created later')
  const plan = await planFiles(store, work, 0)
  assert.deepEqual(plan.files, [])
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-31: apply writes files through the host filesystem, not bare fs', async () => {
  const { base, work, store } = await storeFixture()
  const file = path.join(work, 'a.txt')
  await fs.writeFile(file, 'before')
  await captureFile(store, work, file)
  await fs.writeFile(file, 'after')

  const host = fakeHostFs(work, new Set([file]))
  const live = fakeSession('s1', [appended(0, 'system/message'), appended(1)], { cwd: work })
  const ctx = fakeCtx({ sessions: { get: () => live }, agents: { get: () => ({ status: 'idle' }) }, fsService: host, workspaceRoot: work })
  const rewind = createRewind({ ctx, store })
  await rewind.plan({ sessionId: 's1', seq: 1 })
  await assert.rejects(rewind.apply({ sessionId: 's1', seq: 1, restoreFiles: true }), /还原文件失败/)
  assert.deepEqual(host.calls, [{ op: 'write', path: file }], '写回走的是宿主文件系统')
  assert.equal(await fs.readFile(file, 'utf8'), 'after', '被宿主拒绝的写回没有落盘')
  // 文件没还原成功就不切对话：日志里没有标记。
  assert.equal(live.snapshotEvents().length, 2)
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-21: a turn that stops after the preview does not void the rewind', async () => {
  const { base, work, store } = await storeFixture()
  const live = fakeSession('s1', [appended(0, 'system/message'), appended(1), appended(2, 'assistant/message')], { cwd: work })
  let cancels = 0
  let status = 'running'
  const agents = {
    get: () => ({
      // 每次读取都要看当前值：settle 拿到 agent 后会轮询它的 status。
      get status() {
        return status
      },
      cancel: () => {
        cancels += 1
        status = 'idle'
        // 被停下的回合在退出前还会落一条消息：这正是确认时看不到的那部分。
        live.append('assistant/message', { content: [{ type: 'text', text: 'late' }] }, { surfaceOp: 'append' })
      },
    }),
  }
  const ctx = fakeCtx({ sessions: { get: () => live }, agents, fsService: fakeHostFs(work), workspaceRoot: work })
  const rewind = createRewind({ ctx, store })

  const plan = await rewind.plan({ sessionId: 's1', seq: 1 })
  // 预览之后日志继续增长（回合还没停）：这些内容本来就该一起撤掉，不能因此拒绝。
  live.append('user/message', { content: [{ type: 'text', text: 'oops' }], source: { kind: 'user' }, role: 'user' }, { surfaceOp: 'append' })
  const applied = await rewind.apply({ sessionId: 's1', seq: 1, restoreFiles: false, planToken: plan.planToken })
  assert.equal(cancels, 1, '停回合发生在范围校验之后')
  // 停回合时落下的那条消息也在撤销范围里：目标之后到末尾整段都被替换。
  assert.equal(applied.hidden, 4)
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-21: apply refuses a target a later marker already hid', async () => {
  const { base, work, store } = await storeFixture()
  const live = fakeSession('s1', [appended(0, 'system/message'), appended(1), appended(2, 'assistant/message')], { cwd: work })
  let cancels = 0
  const ctx = fakeCtx({
    sessions: { get: () => live },
    agents: { get: () => ({ status: 'idle', cancel: () => { cancels += 1 } }) },
    fsService: fakeHostFs(work),
    workspaceRoot: work,
  })
  const rewind = createRewind({ ctx, store })

  const plan = await rewind.plan({ sessionId: 's1', seq: 1 })
  // 别处先回撤了一次，目标消息被标记盖掉：这时候再按旧预览执行就会切错位置。
  live.append('user/message', markerData({ startSeq: 1, endSeq: 2 }), markerOptions({ startSeq: 1, endSeq: 2 }))
  await assert.rejects(
    rewind.apply({ sessionId: 's1', seq: 1, restoreFiles: false, planToken: plan.planToken }),
    /已经不在当前对话里/,
  )
  assert.equal(cancels, 0)
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-21: a valid preview still applies', async () => {
  const { base, work, store } = await storeFixture()
  const live = fakeSession('s1', [appended(0, 'system/message'), appended(1), appended(2, 'assistant/message')], { cwd: work })
  const ctx = fakeCtx({ sessions: { get: () => live }, agents: { get: () => ({ status: 'idle' }) }, fsService: fakeHostFs(work), workspaceRoot: work })
  const rewind = createRewind({ ctx, store })
  const plan = await rewind.plan({ sessionId: 's1', seq: 1 })
  const applied = await rewind.apply({ sessionId: 's1', seq: 1, restoreFiles: false, planToken: plan.planToken })
  assert.equal(applied.markerSeq, 3)
  await fs.rm(base, { recursive: true, force: true })
})

test('P1-21: an invalid target is rejected before the running turn is stopped', async () => {
  const { base, work, store } = await storeFixture()
  const live = fakeSession('s1', [appended(0, 'system/message'), appended(1), appended(2, 'assistant/message')], { cwd: work })
  let cancels = 0
  let status = 'running'
  const agents = {
    get: () => ({
      // 每次读取都要看当前值：settle 拿到 agent 后会轮询它的 status。
      get status() {
        return status
      },
      cancel: () => {
        cancels += 1
        status = 'idle'
        // 被停下的回合在退出前还会落一条消息：这正是确认时看不到的那部分。
        live.append('assistant/message', { content: [{ type: 'text', text: 'late' }] }, { surfaceOp: 'append' })
      },
    }),
  }
  const ctx = fakeCtx({ sessions: { get: () => live }, agents, fsService: fakeHostFs(work), workspaceRoot: work })
  const rewind = createRewind({ ctx, store })
  await assert.rejects(rewind.apply({ sessionId: 's1', seq: 2, restoreFiles: false }), /只能回撤到用户消息/)
  assert.equal(cancels, 0)
  await fs.rm(base, { recursive: true, force: true })
})

test('SEC-10: every entry point rejects a path-like session id', async () => {
  const { base, work, store } = await storeFixture()
  const live = fakeSession('s1', [appended(0, 'system/message'), appended(1)], { cwd: work })
  const ctx = fakeCtx({ sessions: { get: () => live }, agents: { get: () => ({ status: 'idle' }) }, fsService: fakeHostFs(work), workspaceRoot: work })
  const rewind = createRewind({ ctx, store })
  for (const sessionId of ['../escape', '.', '..', 'a/b', '']) {
    await assert.rejects(rewind.plan({ sessionId, seq: 0 }), (error) => error.status === 400, `plan rejects ${sessionId}`)
    await assert.rejects(rewind.apply({ sessionId, seq: 0 }), (error) => error.status === 400, `apply rejects ${sessionId}`)
    await assert.rejects(rewind.cuts(sessionId), (error) => error.status === 400, `cuts rejects ${sessionId}`)
  }
  await fs.rm(base, { recursive: true, force: true })
})

/* ---------------------------------------------------------------- 组件挂载 */

test('the component mounts against a minimal context', async () => {
  const module = await import('../host/rewind/index.js')
  const disposers = []
  const routes = []
  const events = []
  const ctx = {
    root: {},
    get: (name) => (name === 'sessions' ? { get: () => undefined } : undefined),
    effect: (run) => {
      const dispose = run()
      disposers.push(dispose)
    },
    on: (event) => {
      events.push(event)
      return () => {}
    },
    connection: { requestRejection: () => undefined },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  assert.doesNotThrow(() => module.apply(ctx))
  assert.equal(routes.length, 1, 'the route is registered')
  assert.equal(routes[0].path, '/rewind/api')
  assert.equal(typeof routes[0].handler, 'function')
  // 捕获挂在工具真正执行的位置（审批与守卫之后），而不是权限门之前。
  assert.deepEqual(events, ['tools/execute'])
  for (const dispose of disposers) assert.equal(typeof dispose, 'function', 'every effect returns its disposer')

  // 真的走一遍路由：没有持久化服务时，读一个不存在的会话得到 404 JSON。
  const response = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(body) {
      this.body = body
    },
  }
  await routes[0].handler({ url: '/rewind/api/cuts?sessionId=s1', method: 'GET' }, response)
  assert.equal(response.statusCode, 404)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '找不到会话。' })

  // 路径形态的会话 id 在进入持久化之前就被拒。
  const rejected = { ...response, statusCode: 0, body: undefined }
  await routes[0].handler({ url: '/rewind/api/cuts?sessionId=..%2Fescape', method: 'GET' }, rejected)
  assert.equal(rejected.statusCode, 400)
  assert.deepEqual(JSON.parse(rejected.body), { ok: false, error: '会话标识不合法。' })
})

test('the capture hook snapshots before the tool body and confirms after it', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'yk-rewind-home-'))
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'yk-rewind-work-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const file = path.join(work, 'a.txt')
    await fs.writeFile(file, 'before')
    const live = fakeSession('s1', [appended(0, 'system/message'), appended(1)], { cwd: work })
    const host = fakeHostFs(work)
    const hooks = []
    const ctx = {
      get: (name) =>
        ({
          sessions: { get: () => live },
          agents: { get: () => ({ status: 'idle' }) },
          fs: host,
          sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: work }) },
          workingDirectory: { ensure: async () => work },
        })[name],
      effect: (run) => {
        run()
      },
      on: (event, handler) => {
        hooks.push({ event, handler })
        return () => {}
      },
      connection: { requestRejection: () => undefined },
      webServer: { register: () => () => {} },
      logger: { warn: () => {} },
    }
    const module = await import('../host/rewind/index.js')
    module.apply(ctx)
    const hook = hooks.find((item) => item.event === 'tools/execute')
    assert.ok(hook, 'capture rides tools/execute')

    let seenInside = -1
    const result = await hook.handler({ name: 'write', arguments: { file_path: file, content: 'after' }, agent: { session: live } }, async () => {
      const dir = path.join(home, 'rewind', 's1')
      seenInside = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).length
      await fs.writeFile(file, 'after')
      return { isError: false }
    })
    assert.deepEqual(result, { isError: false })
    assert.equal(seenInside, 1, '快照在工具体执行之前已经落盘')
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(work, { recursive: true, force: true })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('a client module without the rewind route does not mount the button', async () => {
  // 客户端在 404 时放弃接管；这里只锁住这个判断，避免组件关掉后还改渲染身份。
  const client = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(client.includes("return error?.status !== 404"), 'a missing host half reads as unavailable')
})

test('the marker carries the cut start so the client can derive the span', () => {
  const data = markerData({ startSeq: 7, endSeq: 9, shadowed: [7, 8, 9] })
  assert.equal(data.source.kind, MARKER_SOURCE_KIND)
  assert.equal(data.source.start, 7)
})
