import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ANCHOR_ORDER,
  ANCHOR_SENTINEL,
  HEAD_SENTINEL,
  RULES_ANCHOR_SECTION,
  RULES_ORDER,
  RULES_SECTION,
  renderRules,
} from '../host/rules/lib/render.js'
import {
  assertWritable,
  createDocCache,
  readDoc,
  removeDoc,
  truncateBufferUtf8,
  writeDoc,
} from '../host/rules/lib/store.js'
import { findProjectRoot, isInside, workspaceFile } from '../host/rules/lib/paths.js'
import { resolveScope, sessionCwd, workspaceFor, workspaceList } from '../host/rules/lib/scope.js'
import { normalizeSettings, readSettings, writeSettings } from '../host/rules/lib/settings.js'

async function temporary(t, prefix = 'yk-rules-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** A read-doc shape for render tests. */
function doc(filePath, text, extra = {}) {
  return { path: filePath, exists: true, text, bytes: Buffer.byteLength(text, 'utf8'), truncated: false, mtimeMs: 1, ...extra }
}

const absent = (filePath) => ({ path: filePath, exists: false, text: '', bytes: 0, truncated: false, mtimeMs: 0 })

/* ------------------------------------------------------------------ render */

test('render: two absent files add nothing to the prompt', () => {
  const rendered = renderRules({ global: absent('/h/rules.md'), project: absent('/w/rules.md') })
  assert.equal(rendered.head, '')
  assert.equal(rendered.anchor, '')
  assert.deepEqual(rendered.scopes, { global: false, project: false })
})

test('render: the head carries both scopes and the anchor repeats only the global one', () => {
  const rendered = renderRules({
    global: doc('/h/rules.md', '全局规则'),
    project: doc('/w/rules.md', '项目规则'),
    maxBytes: 16384,
  })
  assert.ok(rendered.head.startsWith(HEAD_SENTINEL))
  assert.match(rendered.head, /## 全局约束/u)
  assert.match(rendered.head, /来源：\/h\/rules\.md/u)
  assert.match(rendered.head, /全局规则/u)
  assert.match(rendered.head, /## 工作区约束/u)
  assert.match(rendered.head, /项目规则/u)
  assert.ok(rendered.head.includes('不要修改它们'))
  assert.ok(rendered.anchor.startsWith(ANCHOR_SENTINEL))
  assert.ok(rendered.anchor.includes('全局规则'))
  assert.ok(rendered.anchor.includes('全程有效'))
  // 工作区那份全文只在文首：尾部重复它每轮要多付几千 token。
  assert.equal(rendered.anchor.includes('项目规则'), false)
  assert.match(rendered.anchor, /工作区约束全文只出现在文首/u)
  assert.ok(Buffer.byteLength(rendered.anchor, 'utf8') < Buffer.byteLength(rendered.head, 'utf8'))
})

test('render: a disabled scope and an empty file are omitted', () => {
  const rendered = renderRules({
    global: doc('/h/rules.md', '全局规则'),
    project: doc('/w/rules.md', '项目规则'),
    enabled: { project: false },
  })
  assert.match(rendered.head, /全局规则/u)
  assert.doesNotMatch(rendered.head, /项目规则/u)
  assert.deepEqual(rendered.scopes, { global: true, project: false })

  const empty = renderRules({ global: doc('/h/rules.md', '   \n'), project: absent('/w/rules.md') })
  assert.equal(empty.head, '')
})

test('render: identical workspace text is deduplicated', () => {
  const rendered = renderRules({
    global: doc('/h/rules.md', '同一条规则'),
    project: doc('/w/rules.md', '同一条规则\n'),
  })
  assert.match(rendered.head, /与全局约束内容相同/u)
  assert.equal(rendered.head.includes('## 工作区约束'), false)
  assert.deepEqual(rendered.scopes, { global: true, project: false })
})

test('render: a project-only file still produces both halves', () => {
  const rendered = renderRules({ global: absent('/h/rules.md'), project: doc('/w/rules.md', '项目规则') })
  assert.ok(rendered.head.includes(HEAD_SENTINEL))
  assert.ok(rendered.head.includes('## 工作区约束'))
  assert.equal(rendered.head.includes('## 全局约束'), false)
  assert.equal(rendered.anchor.includes('项目规则'), false)
  assert.match(rendered.anchor, /工作区约束全文只出现在文首/u)
  assert.deepEqual(rendered.scopes, { global: false, project: true })
})

test('render: a truncated file carries the byte note', () => {
  const rendered = renderRules({
    global: doc('/h/rules.md', '内容', { bytes: 40000, truncated: true }),
    maxBytes: 16384,
  })
  assert.match(rendered.head, /\[已截断：原文 40000 字节，注入上限 16384 字节\]/u)
})

test('render: both halves label a truncated file with its original size', () => {
  const rendered = renderRules({
    global: doc('/h/rules.md', '规则😀正文', { bytes: 40000, truncated: true }),
    maxBytes: 16384,
  })
  for (const half of [rendered.head, rendered.anchor]) {
    assert.match(half, /规则😀正文/u)
    assert.match(half, /\[已截断：原文 40000 字节，注入上限 16384 字节\]/u)
  }
})

test('render: tailAnchor=false leaves only the head section', () => {
  const rendered = renderRules({ global: doc('/h/rules.md', '规则'), tailAnchor: false })
  assert.notEqual(rendered.head, '')
  assert.equal(rendered.anchor, '')
})

test('render: section names and orders stay where the design put them', () => {
  assert.equal(RULES_SECTION, 'yukari:rules')
  assert.equal(RULES_ANCHOR_SECTION, 'yukari:rules-anchor')
  assert.equal(RULES_ORDER, -950)
  assert.equal(ANCHOR_ORDER, 10400)
})

/* ------------------------------------------------------------------- store */

test('store: writing then reading a file leaves no temporary sibling', async (t) => {
  const directory = await temporary(t)
  const file = path.join(directory, 'rules.md')
  writeDoc(file, '第一条规则\n')
  assert.equal(readDoc(file).text, '第一条规则\n')
  assert.deepEqual(await readdir(directory), ['rules.md'])
  await removeDoc(file)
  assert.equal(readDoc(file).exists, false)
  await removeDoc(file)
})

test('store: a changed file invalidates the cache; a missing file is never cached', async (t) => {
  const directory = await temporary(t)
  const file = path.join(directory, 'rules.md')
  const cache = createDocCache()
  assert.equal(cache.read(file).exists, false)

  writeDoc(file, 'AAA')
  assert.equal(cache.read(file).text, 'AAA')
  writeDoc(file, 'BBBB')
  assert.equal(cache.read(file).text, 'BBBB')

  const before = cache.read(file)
  writeDoc(file, 'CCCCC')
  assert.equal(cache.read(file).text, 'CCCCC')
  assert.notEqual(before.text, 'CCCCC')
})

test('store: a same-size rewrite invalidates the cache even when the stat signature does not move', async (t) => {
  const directory = await temporary(t)
  const file = path.join(directory, 'rules.md')
  writeDoc(file, 'FIRST')
  const cache = createDocCache()
  assert.equal(cache.read(file).text, 'FIRST')

  // 实测 overlayfs 的 mtime/ctime 只到毫秒：同一毫秒内的同尺寸改写，stat 签名
  // 完全不变。把 stat 冻结在这里，模拟时间戳无法区分两次写入的情形。
  const frozen = fs.statSync(file)
  t.mock.method(fs, 'statSync', () => frozen)

  writeDoc(file, 'OTHER')
  assert.equal(cache.read(file).text, 'OTHER')
})

test('store: truncation cuts on a UTF-8 boundary and keeps the byte count', async (t) => {
  const directory = await temporary(t)
  const file = path.join(directory, 'rules.md')
  const text = '中'.repeat(100)
  writeDoc(file, text)
  const doc = readDoc(file, 10)
  assert.equal(doc.truncated, true)
  assert.equal(doc.bytes, Buffer.byteLength(text, 'utf8'))
  assert.equal(doc.text, '中'.repeat(3))
  assert.equal(doc.text.includes('\uFFFD'), false)
  assert.equal(truncateBufferUtf8(Buffer.from('abc中'), 4), 'abc')
})

test('store: every byte ceiling lands on a character boundary, emoji included', async (t) => {
  const directory = await temporary(t)
  const file = path.join(directory, 'rules.md')
  const text = `规则${'😀'.repeat(40)}`
  writeDoc(file, text)
  const total = Buffer.byteLength(text, 'utf8')
  const whole = Buffer.from(text)

  // 前 12 个上限走“只读文件头”的截断路径，末尾几个走“整份读取后再截断”的路径。
  const limits = [...Array.from({ length: 12 }, (_, index) => index + 1), total - 3, total - 2, total - 1, total]
  for (const limit of limits) {
    const doc = readDoc(file, limit)
    assert.equal(doc.text.includes('\uFFFD'), false, `limit ${limit} 出现了替换字符`)
    assert.ok(Buffer.byteLength(doc.text, 'utf8') <= limit, `limit ${limit} 超过了字节上限`)
    assert.equal(doc.text, truncateBufferUtf8(whole, limit), `limit ${limit} 与边界截断不一致`)
    assert.equal(doc.truncated, total > limit)
    assert.equal(doc.bytes, total)
    if (limit < total) assert.ok(whole.subarray(0, Buffer.byteLength(doc.text, 'utf8')).equals(Buffer.from(doc.text)))
  }
})

test('store: a symbolic-link target and a missing workspace are refused', async (t) => {
  const directory = await temporary(t)
  const outside = await temporary(t, 'yk-rules-out-')
  const file = path.join(directory, 'rules.md')
  await writeFile(path.join(outside, 'secret.md'), 'secret')
  await symlink(path.join(outside, 'secret.md'), file)
  assert.throws(() => assertWritable(file, { root: directory }), /符号链接/u)
  assert.throws(() => assertWritable(path.join(outside, 'rules.md'), { root: path.join(directory, 'gone') }), /工作区目录不存在/u)
})

/* ------------------------------------------------------------------- scope */

test('scope: the project root is the nearest ancestor carrying .git', async (t) => {
  const directory = await temporary(t)
  await mkdir(path.join(directory, '.git'), { recursive: true })
  await mkdir(path.join(directory, 'packages', 'app'), { recursive: true })
  assert.equal(findProjectRoot(path.join(directory, 'packages', 'app')), directory)
  assert.equal(findProjectRoot(directory), directory)

  const loose = await temporary(t, 'yk-rules-loose-')
  assert.equal(findProjectRoot(loose), loose)
})

test('scope: session membership beats cwd ancestry, otherwise the longest root wins', () => {
  const list = [
    { id: 'a', title: 'A', path: '/repo', sessionIds: ['s1'] },
    { id: 'b', title: 'B', path: '/repo/pkg', sessionIds: [] },
    { id: 'c', title: 'C', path: '/other', sessionIds: [] },
  ]
  assert.equal(workspaceFor(list, 's1', '/other/deep')?.id, 'a')
  assert.equal(workspaceFor(list, 's2', '/repo/pkg/src')?.id, 'b')
  assert.equal(workspaceFor(list, 's3', '/elsewhere')?.id, undefined)
})

test('scope: a session without a registry falls back to its cwd', () => {
  const ctx = { get: () => undefined }
  const list = workspaceList(ctx)
  assert.equal(list.length, 1)
  const session = { id: 's1', header: { cwd: process.cwd() } }
  assert.equal(sessionCwd(ctx, session), path.resolve(process.cwd()))
  const scope = resolveScope(ctx, session)
  assert.equal(scope.source, 'workspace')
  assert.equal(scope.projectRoot, path.resolve(process.cwd()))
  assert.equal(scope.file, workspaceFile(process.cwd()))
})

test('scope: the workspace registry and working-directory service drive resolution', () => {
  const workspaceRoot = path.resolve('/tmp/yk-rules-ws')
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'w1', title: 'WS', path: workspaceRoot, sessionIds: ['s1'] }] }
      if (name === 'workingDirectory') return { get: () => path.join(workspaceRoot, 'src') }
      return undefined
    },
  }
  const session = { id: 's1' }
  const scope = resolveScope(ctx, session)
  assert.equal(scope.source, 'workspace')
  assert.equal(scope.workspace.id, 'w1')
  assert.equal(scope.file, path.join(workspaceRoot, 'rules.md'))
  assert.equal(isInside(workspaceRoot, scope.file), true)
})

/* ---------------------------------------------------------------- settings */

test('settings: defaults < row config < saved file, and the file is atomic', async (t) => {
  const directory = await temporary(t)
  const file = path.join(directory, 'rules-settings.json')
  assert.deepEqual(normalizeSettings({}), { global: true, project: true, tailAnchor: true })
  assert.equal(readSettings(file, { project: false }).project, false)

  const saved = writeSettings(file, { tailAnchor: false }, { project: false })
  assert.deepEqual(saved, { global: true, project: false, tailAnchor: false })
  assert.equal(readSettings(file).tailAnchor, false)
  const mode = (await stat(file)).mode & 0o777
  assert.equal(mode, 0o600)
})
