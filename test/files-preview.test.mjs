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

test('the preview always sits to the right of the listing', async () => {
  const { text } = await filesTab()
  assert.ok(text.includes('.yk-filesSplit { display: grid; grid-template-columns: minmax(0, 1fr) clamp(280px, 45%, 420px);'), 'the layout is a two-column split that never stacks')
  assert.equal(text.includes('.yk-filesSplit { grid-template-columns: 1fr; }'), false, 'a narrow panel keeps the preview on the right')
  assert.ok(text.includes('height: var(--yk-preview-height, calc(100vh - 24px))'), 'the preview fills the height measured from the panel')
  assert.ok(text.includes(".yk-preview { position: sticky; top: 12px; display: flex; flex-direction: column;"), 'the preview is pinned with a small inset')
  assert.equal(text.includes('max-height: 62vh'), false, 'the preview no longer hugs its content')
  assert.ok(text.includes('.yk-filesSplit { display: grid; grid-template-columns: minmax(0, 1fr) clamp(280px, 45%, 420px); gap: 16px; align-items: start; }'), 'a top-aligned grid item is what makes sticky apply')
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

test('the preview bar carries the controls the session viewer has', async () => {
  const { body, text } = await filesTab()
  for (const label of ['fWrap', 'fAutoRefresh', 'fCopyAll', 'fFullscreen', 'fRevealInTree']) {
    assert.ok(body.includes(`t('${label}')`), `${label} is wired into the bar`)
  }
  assert.ok(body.includes("t('refresh')") && body.includes("t('close')"), 'reload and close sit at the end')
  assert.ok(body.includes('barButton('), 'every control is one shared icon button')
  assert.ok(body.includes("className: 'yk-previewPath'"), 'the bar shows the path, as the session viewer does')
  assert.ok(body.includes("'data-yk-file': entry.path"), 'rows carry the path so reveal can find them')
  assert.ok(body.includes('scrollIntoView'), 'reveal scrolls the listing to the file')
  assert.ok(text.includes('.yk-previewCode-nowrap .yk-previewLineText { white-space: pre; }'), 'turning wrap off keeps the line intact')
  assert.ok(text.includes('.yk-lightbox { position: fixed;'), 'the image opens in a fixed overlay')
})

test('the preview height is measured from the panel, not guessed from the viewport', async () => {
  const { body } = await filesTab()
  assert.ok(body.includes("setProperty('--yk-preview-height'"), 'the measured height lands on the split')
  assert.ok(body.includes('new ResizeObserver(sync)'), 'a resized panel re-measures')
})

test('auto refresh reloads on an interval and stops with the preview', async () => {
  const { body } = await filesTab()
  assert.ok(body.includes("setInterval(() => { void showPreview(previewTarget, true) }, 3000)"), 'the tick re-reads the file quietly')
  assert.ok(body.includes('return () => clearInterval(timer)'), 'the tick stops when the panel goes away')
})
