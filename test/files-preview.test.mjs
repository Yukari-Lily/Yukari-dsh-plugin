import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/** 客户端里那段预览逻辑的真实源码：执行它，而不是在测试里重写一份。 */
async function openPreviewOf() {
  const text = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const start = text.indexOf('async function openPreview(')
  assert.notEqual(start, -1, 'openPreview exists in the client bundle')
  const end = text.indexOf('\n    }\n', start)
  assert.notEqual(end, -1, 'openPreview is terminated')
  const source = text.slice(start, end + 6)
  return new Function(`${source}\nreturn openPreview`)()
}

/** 记录调用的宿主侧栏替身。 */
function sidebar() {
  const opened = []
  return { opened, openResource: (address) => opened.push(address) }
}

const ADDRESS = 'dsh-resource://file/session/s1/README.md'

test('a preview switches to the session first when it is not on screen', async () => {
  const openPreview = await openPreviewOf()
  const right = sidebar()
  const switched = []
  await openPreview({
    right,
    address: ADDRESS,
    sessionId: 's1',
    onScreen: () => 'other',
    switchSession: (id) => switched.push(id),
    wait: async () => true,
  })
  assert.deepEqual(switched, ['s1'], 'the session is opened before the resource')
  assert.deepEqual(right.opened, [ADDRESS], 'the file is placed once the session is on screen')
})

test('a preview opens directly when the session is already on screen', async () => {
  const openPreview = await openPreviewOf()
  const right = sidebar()
  const switched = []
  await openPreview({
    right,
    address: ADDRESS,
    sessionId: 's1',
    onScreen: () => 's1',
    switchSession: (id) => switched.push(id),
    wait: async () => {
      throw new Error('must not wait')
    },
  })
  assert.deepEqual(switched, [], 'no session switch is needed')
  assert.deepEqual(right.opened, [ADDRESS])
})

test('a preview that never finds the session fails loudly instead of doing nothing', async () => {
  const openPreview = await openPreviewOf()
  const right = sidebar()
  await assert.rejects(
    openPreview({
      right,
      address: ADDRESS,
      sessionId: 's1',
      onScreen: () => '',
      switchSession: () => {},
      wait: async () => false,
    }),
    /no-session/,
  )
  assert.deepEqual(right.opened, [], 'nothing is claimed against a sidebar with no session')
})

test('a preview without the sidebar service reports itself', async () => {
  const openPreview = await openPreviewOf()
  await assert.rejects(
    openPreview({ right: undefined, address: ADDRESS, sessionId: 's1', onScreen: () => 's1', switchSession: () => {}, wait: async () => true }),
    /no-preview/,
  )
})

test('the files page awaits the preview so a rejection reaches its error line', async () => {
  const text = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(text.includes('await ui.openResource('), 'the click handler awaits the host call')
  assert.equal(text.includes("ui.openSession(payload.sessionId)\n            await new Promise((resolve) => setTimeout(resolve, 400))"), false, 'the fixed 400ms retry is gone')
  assert.ok(text.includes('function waitForSession('), 'the panel waits for the session to mount')
})
