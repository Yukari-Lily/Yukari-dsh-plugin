/**
 * 真实 DOM 用例的入口：在子进程里跑 `ui-dom-run.mjs`，检查它跑完且没有报错。
 *
 * 子进程是必要的：React 19 的调度器在当前 node:test 进程里退出时会留下一个
 * 永不落地的微任务，直接跑会把整个 `node --test` 挂住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the real panel renders and keeps visited tabs alive', async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, 'test', 'ui-dom-run.mjs')], {
    cwd: root,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  assert.match(stdout, /^ok tabs$/m)
  assert.match(stdout, /^ok keep-alive$/m)
  assert.match(stdout, /^ok confirm-focus$/m)
  assert.match(stdout, /^ok chat-counts$/m)
  assert.match(stdout, /^ok chat-preview$/m)
  assert.match(stdout, /^ok chat-preview-below$/m)
  assert.match(stdout, /^ok chat-preview-tap$/m)
  assert.match(stdout, /^ok chat-preview-gone$/m)
  assert.match(stdout, /^ok files-markdown$/m)
  assert.match(stdout, /^ok probe-note$/m)
  assert.match(stdout, /^ok restart-watch$/m)
  assert.match(stdout, /^ok update-applies$/m)
  assert.match(stdout, /^ok update-restarts$/m)
  assert.match(stdout, /^ok restart-resume$/m)
  assert.match(stdout, /^ok restart-already-done$/m)
  assert.match(stdout, /^ok runtime-rollback$/m)
  assert.match(stdout, /^ok chat-visibility$/m)
  assert.match(stdout, /^ok github-signing$/m)
  assert.match(stdout, /^ok skills$/m)
  assert.match(stdout, /^ok picker-memory$/m)
  assert.match(stdout, /^ok picker-memory-seeded$/m)
})

test('DOM assertions compare text, never the node itself', () => {
  // 节点上挂着 React 的 `__reactFiber$…` 引用：断言失败时 Node 要把它格式化进错误
  // 信息，顺着引用能展开整棵组件树。把节点直接交给 assert 的写法一旦红，进程会被
  // 内存拖死，而不是报一条普通的失败——所以这里只放字符串和布尔值。
  const source = readFileSync(path.join(root, 'test', 'ui-dom-run.mjs'), 'utf8')
  const raw = /assert\.\w+\([^\n]*querySelector(?:All)?\([^)\n]*\)\s*[,)]/gu
  const hits = [...source.matchAll(raw)].map((match) => match[0].trim())
  assert.deepEqual(hits, [], 'assert 收到的是 DOM 节点，请改成 ?.textContent 或布尔值')
})
