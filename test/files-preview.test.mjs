import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/** 文件页在 client bundle 里的源码片段。 */
async function filesTab() {
  const text = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const start = text.indexOf('function FilesTab(')
  assert.notEqual(start, -1, 'FilesTab exists')
  const end = text.indexOf('/* ---------------------------------------------------------------- proxy */', start)
  assert.notEqual(end, -1, 'FilesTab is terminated')
  return { text, body: text.slice(start, end) }
}

test('the file preview lives in the panel and never switches the session', async () => {
  const { body } = await filesTab()
  assert.equal(body.includes('data-conversation-session'), false, 'the preview does not look for a chat on screen')
  assert.equal(body.includes('openSession'), false, 'nothing is switched to reach a preview')
  assert.equal(body.includes('sidebarRight'), false, 'the right sidebar is not involved')
  assert.equal(body.includes('ui.openResource'), false, 'the panel does not borrow the session preview')
  assert.ok(body.includes('`${API.files}/preview${query}`'), 'the content comes from the file component itself')
})

test('the preview matches the host document viewer', async () => {
  const { body, text } = await filesTab()
  assert.ok(body.includes("h(MarkdownView, { text })"), 'markdown uses the host renderer, like the session preview')
  assert.ok(body.includes("'yk-previewLineNo'"), 'plain text keeps line numbers, like the session preview')
  assert.ok(body.includes('&inline=1'), 'images load through the inline download')
  assert.equal(body.includes('CodeBlock'), false, 'the session preview does not highlight code, so neither does this one')
  assert.ok(text.includes('.yk-previewLine { display: grid; grid-template-columns: 3.2em minmax(0, 1fr);'), 'the gutter holds the numbers')
})

test('the preview stays out of the way until a file is chosen', async () => {
  const { body } = await filesTab()
  assert.ok(body.includes("previewTarget === null ? 'yk-filesBody' : 'yk-filesSplit'"), 'the list takes the full width by default')
  assert.ok(body.includes("previewTarget === null ? null : h('section', { className: 'yk-preview'"), 'no preview surface is rendered without a target')
})

test('the listing and the preview share one split, collapsing when narrow', async () => {
  const { text } = await filesTab()
  assert.ok(text.includes('.yk-filesSplit { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 420px);'), 'the layout is a two-column split')
  assert.ok(text.includes('@container (max-width: 760px) { .yk-filesSplit { grid-template-columns: 1fr; }'), 'a narrow panel stacks them')
  assert.ok(text.includes(".yk-preview { display: flex; flex-direction: column;"), 'the preview is a bordered surface')
})

test('changing folder clears the preview', async () => {
  const { body } = await filesTab()
  const go = /const go = \(next\) => \{([^}]*)\}/.exec(body)
  assert.notEqual(go, null, 'the breadcrumb handler is a single expression')
  assert.ok(go[1].includes('closePreview()'), 'a stale file from the previous folder is dropped')
})

test('the preview opens from the row name and from the row action', async () => {
  const { body } = await filesTab()
  assert.equal((body.match(/onClick: \(\) => showPreview\(entry\)/g) ?? []).length, 2, 'both entry points open the panel preview')
  assert.equal(body.includes('onClick: () => preview(entry)'), false, 'the old session-scoped call is gone')
})
