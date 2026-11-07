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

test('the panel renders the preview with the host components', async () => {
  const { body } = await filesTab()
  assert.ok(body.includes('MarkdownView'), 'markdown uses the host renderer')
  assert.ok(body.includes('CodeView'), 'code uses the host highlighter')
  assert.ok(body.includes("lang: languageOf(name)"), 'the language comes from the host file-extension map')
  assert.ok(body.includes("'&inline=1'") || body.includes('&inline=1'), 'images load through the inline download')
})

test('the listing and the preview share one split, collapsing when narrow', async () => {
  const { text } = await filesTab()
  assert.ok(text.includes('.yk-filesSplit { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 380px);'), 'the layout is a two-column split')
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
