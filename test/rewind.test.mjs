import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MARKER_TEXT, markerData, markerOptions } from '../host/rewind/lib/marker.js'
import { cutsOf, planCut, surfaceNodes } from '../host/rewind/lib/surface.js'
import { createSnapshotStore } from '../host/rewind/lib/store.js'
import { createRewind } from '../host/rewind/lib/controller.js'

/** 一条按顺序追加的 surface 事件。 */
const appended = (seq, type = 'user/message', text = `m${seq}`) => ({
  seq,
  type,
  data: { content: [{ type: 'text', text }] },
  surfaceOp: 'append',
})

/** 一条带替换区间的事件。 */
const replacement = (seq, startSeq, endSeq, type = 'user/message', text = MARKER_TEXT) => ({
  seq,
  type,
  data: { content: [{ type: 'text', text }] },
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

test('planCut leaves the target in place and takes everything after it', () => {
  const events = [
    appended(0, 'system/message'),
    appended(1),
    appended(2, 'assistant/message'),
    appended(3),
    appended(4, 'assistant/message'),
  ]
  assert.deepEqual(planCut(events, 3), { startSeq: 4, endSeq: 4, shadowed: [4] })
  assert.deepEqual(planCut(events, 4), { startSeq: null, endSeq: null, shadowed: [] })
  assert.equal(planCut(events, 9), null)
})

test('cutsOf reads the spans back out of the log', () => {
  const events = [appended(0, 'system/message'), appended(1), appended(2), replacement(3, 2, 2)]
  assert.deepEqual(cutsOf(events), [{ start: 2, marker: 3 }])
  // 普通用户消息不会被当成标记。
  assert.deepEqual(cutsOf([appended(0, 'system/message'), appended(1)]), [])
})

test('the marker carries a non-empty body and every shadowed seq', () => {
  const data = markerData()
  assert.equal(data.content[0].text, MARKER_TEXT)
  assert.equal(data.source.kind, 'user')
  const options = markerOptions({ startSeq: 2, endSeq: 3, shadowed: [2, 3] })
  assert.deepEqual(options.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 3 })
  assert.deepEqual(options.sourceEventSeqs, [2, 3])
})

/** 临时目录里的快照仓库。 */
async function storeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yk-rewind-'))
  const store = createSnapshotStore({ root })
  return { root, store }
}

test('a capture restores the bytes that were there before the tool wrote', async () => {
  const { store, root } = await storeFixture()
  const file = path.join(root, 'work', 'a.txt')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, 'before')
  await store.capture({ sessionId: 's1', anchorSeq: 5, target: file })
  await fs.writeFile(file, 'after')
  const plan = await store.planRestore('s1', 3)
  assert.deepEqual(plan.files, [{ path: file, action: 'write' }])
  const result = await store.restore('s1', 3)
  assert.equal(result.restored, 1)
  assert.equal(await fs.readFile(file, 'utf8'), 'before')
})

test('a file created after the rewind point is deleted again', async () => {
  const { store, root } = await storeFixture()
  const file = path.join(root, 'new.txt')
  await store.capture({ sessionId: 's1', anchorSeq: 5, target: file })
  await fs.writeFile(file, 'created')
  const plan = await store.planRestore('s1', 4)
  assert.deepEqual(plan.files, [{ path: file, action: 'delete' }])
  const result = await store.restore('s1', 4)
  assert.equal(result.deleted, 1)
  await assert.rejects(fs.stat(file), /ENOENT/)
})

test('snapshots at or before the rewind point are left alone', async () => {
  const { store, root } = await storeFixture()
  const file = path.join(root, 'b.txt')
  await fs.writeFile(file, 'old')
  await store.capture({ sessionId: 's1', anchorSeq: 2, target: file })
  await fs.writeFile(file, 'new')
  const plan = await store.planRestore('s1', 3)
  assert.deepEqual(plan.files, [])
  const result = await store.restore('s1', 3)
  assert.equal(result.restored, 0)
  assert.equal(await fs.readFile(file, 'utf8'), 'new')
})

test('capture refuses paths that are not absolute files', async () => {
  const { store, root } = await storeFixture()
  assert.deepEqual(await store.capture({ sessionId: 's1', anchorSeq: 1, target: 'relative.txt' }), { skipped: 'relative-path' })
  const dir = path.join(root, 'dir')
  await fs.mkdir(dir)
  assert.deepEqual(await store.capture({ sessionId: 's1', anchorSeq: 1, target: dir }), { skipped: 'not-a-file' })
})

test('plan and apply run against a fake session', async () => {
  const { store, root } = await storeFixture()
  let events = [
    appended(0, 'system/message'),
    appended(1),
    appended(2, 'assistant/message'),
    appended(3),
  ]
  const live = {
    id: 's1',
    seq: 4,
    snapshotEvents: () => events,
    append: (type, data, options) => {
      const event = { seq: events.length, type, time: Date.now(), data, ...options }
      events = [...events, event]
      live.seq = events.length
      return event
    },
  }
  const agents = { get: () => ({ status: 'idle' }) }
  const ctx = { get: (name) => ({ sessions: { get: (id) => (id === 's1' ? live : undefined) }, agents })[name] }
  const rewind = createRewind({ ctx, store })

  const plan = await rewind.plan({ sessionId: 's1', seq: 1 })
  assert.equal(plan.startSeq, 2)
  assert.equal(plan.endSeq, 3)
  assert.equal(plan.tail, 2)
  assert.equal(plan.hidden, 2)

  // 只能撤用户消息；最后一条消息后面没有内容，也不做空操作。
  await assert.rejects(rewind.plan({ sessionId: 's1', seq: 2 }), /只能回撤到用户消息/)
  await assert.rejects(rewind.plan({ sessionId: 's1', seq: 3 }), /之后没有内容/)

  const applied = await rewind.apply({ sessionId: 's1', seq: 1, restoreFiles: false })
  assert.equal(applied.markerSeq, 4)
  assert.equal(events[4].surfaceOp.op, 'replace')
  assert.deepEqual(events[4].sourceEventSeqs, [2, 3])
  // 目标消息留在 surface 上，标记收在它后面。
  assert.deepEqual(surfaceNodes(events), [0, 1, 4])
  assert.deepEqual(await rewind.cuts('s1'), [{ start: 2, marker: 4 }])

  await assert.rejects(rewind.plan({ sessionId: 's1', seq: 3 }), /已经不在当前对话里/)
  await fs.rm(root, { recursive: true, force: true })
})

test('apply refuses a session that is not loaded', async () => {
  const { store, root } = await storeFixture()
  const ctx = { get: () => undefined }
  const rewind = createRewind({ ctx, store })
  await assert.rejects(rewind.apply({ sessionId: 'nope', seq: 1 }), /没有在运行中的 Host 里加载/)
  await fs.rm(root, { recursive: true, force: true })
})

test('the component mounts against a minimal context', async () => {
  const module = await import('../host/rewind/index.js')
  const disposers = []
  const routes = []
  const ctx = {
    root: {},
    get: (name) => (name === 'sessions' ? { get: () => undefined } : undefined),
    effect: (run) => {
      const dispose = run()
      disposers.push(dispose)
    },
    on: () => () => {},
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
})

test('a client module without the rewind route does not mount the button', async () => {
  // 客户端在 404 时放弃接管；这里只锁住这个判断，避免组件关掉后还改渲染身份。
  const client = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(client.includes("return error?.status !== 404"), 'a missing host half reads as unavailable')
})
