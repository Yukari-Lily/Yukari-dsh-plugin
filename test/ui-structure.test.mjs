import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/** The client bundle as text: the panel has no build step to inspect. */
const source = () => readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Text of one inline dictionary. */
function dictionary(text, name) {
  const start = text.indexOf(`    const ${name} = {`)
  assert.notEqual(start, -1, `${name} dictionary not found`)
  const end = text.indexOf('\n    }', start)
  return text.slice(start, end)
}

/** Value of one dictionary key, unquoted. */
function entry(text, name, key) {
  const block = dictionary(text, name)
  const match = new RegExp(`^\\s{6}${key}:\\s*(['\`])([\\s\\S]*?)\\1,?$`, 'm').exec(block)
  assert.notEqual(match, null, `${name}.${key} is missing`)
  return match[2]
}

test('every preset subpage uses the shared header, with the back button first', async () => {
  const text = await source()
  const header = text.indexOf('function SubpageHeader')
  assert.notEqual(header, -1, 'SubpageHeader exists')
  const body = text.slice(header, text.indexOf('function Card', header))
  const back = body.indexOf("'yk-btn yk-btn-ghost yk-iconBtn yk-backBtn'")
  const title = body.indexOf("'yk-subpageTitle'")
  assert.ok(back !== -1 && title !== -1, 'the header holds a back button and a title')
  assert.ok(back < title, 'the back button is rendered on the left, before the title')

  // Edit, composition, template and both import steps all share that header.
  const uses = text.match(/h\(SubpageHeader, \{/g) ?? []
  assert.ok(uses.length >= 5, `expected the shared header in every subpage, found ${uses.length}`)
  assert.equal(text.includes("className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: closeEditor"), false, 'no right-aligned back button is left behind')
})

test('the GitHub, rules and presets pages keep their introductions short', async () => {
  const text = await source()
  const limits = {
    zh: { pIntro: 40, pTrust: 30, kDesc: 40, ghSecurityHint: 60, ghStepAccess: 60, ghStorage: 40, pChooseTemplateHint: 30 },
    en: { pIntro: 60, pTrust: 45, kDesc: 60, ghSecurityHint: 120, ghStepAccess: 100, ghStorage: 60, pChooseTemplateHint: 50 },
  }
  for (const [locale, fields] of Object.entries(limits)) {
    for (const [key, max] of Object.entries(fields)) {
      const value = entry(text, locale, key)
      assert.ok(value.length <= max, `${locale}.${key} is ${value.length} chars, over the ${max}-character budget`)
    }
  }
})

test('the three pages share the panel primitives rather than private layout', async () => {
  const text = await source()
  for (const name of ['GithubTab', 'RulesTab', 'PresetsTab']) {
    const start = text.indexOf(`function ${name}(`)
    assert.notEqual(start, -1, `${name} exists`)
    const body = text.slice(start, text.indexOf('\n    /*', start))
    assert.ok(body.includes('h(Card') || body.includes('h(Disclosure'), `${name} uses the shared card surface`)
  }
  // Long secondary explanations belong in the shared disclosure, not in a wall of text.
  assert.ok(text.includes("h(Disclosure, { title: t('kDetails') }"), 'rules details are collapsed behind a disclosure')
  assert.ok(text.includes("h(Disclosure, {\n            { title: t('pAdvanced')") || text.includes("title: t('pAdvanced')"), 'preset JSON uses the disclosure')
})

test('a chat row confirms inside its own actions, without hiding the row', async () => {
  const text = await source()
  const start = text.indexOf('const renderRow = (row, group')
  assert.notEqual(start, -1, 'renderRow exists')
  const row = text.slice(start, text.indexOf('const renderGroup', start))
  assert.equal(row.includes('yk-confirmInline'), false, 'nothing is pushed in under the row')
  assert.equal(row.includes('yk-itemConfirm'), false, 'the row itself is not replaced')
  assert.ok(row.includes('h(ConfirmActions, {'), 'only the actions area turns into the confirm')
  assert.ok(row.includes("'yk-itemActions yk-itemActionsConfirm'"), 'the confirm keeps the row layout')
  assert.ok(text.includes('.yk-dangerText { color: var(--dsw-alias-state-error-primary);'), 'the confirm label is the only red thing')
  const confirm = text.slice(text.indexOf('function ConfirmActions'), text.indexOf('function OffState'))
  assert.equal(confirm.includes('yk-confirmHint'), false, 'no hint paragraph in the confirm')
  assert.equal(confirm.includes('yk-itemConfirm'), false, 'no box or separate row')
})

test('panel layout lives in the stylesheet, not in inline style attributes', async () => {
  const text = await source()
  // 行内 style 只留给随数据变化的尺寸（进度、logo 边长）；其余一律走样式类。
  const inline = text.match(/style: \{[^}]*\}/g) ?? []
  assert.ok(inline.length > 0, 'the scan found the inline styles')
  const fixed = inline.filter((value) => !value.includes('${'))
  assert.deepEqual(fixed, [], 'static sizes belong in the stylesheet')
})

test('controls in one toolbar share height, radius and type scale', async () => {
  const text = await source()
  const rule = (selector) => {
    const match = new RegExp(`^${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'm').exec(text)
    assert.notEqual(match, null, `${selector} exists`)
    return match[1]
  }
  const height = (selector) => {
    const found = /(?:^|;)\s*height:\s*(\d+)px/.exec(rule(selector))
    return found === null ? null : Number(found[1])
  }
  assert.equal(height('.yk-input'), 34, 'inputs are 34px')
  assert.equal(height('.yk-search'), 34, 'search boxes match inputs')
  assert.equal(height('.yk-select'), 34, 'selects match inputs')
  assert.ok(/min-height: 32px/.test(rule('.yk-btn')), 'buttons are 32px tall')
  assert.ok(/min-height: 28px/.test(rule('.yk-btn-sm')), 'small buttons are 28px tall')
  assert.ok(/border-radius: var\(--dsw-radius-sm\)/.test(rule('.yk-segItem')), 'segment items share the indicator radius')
  // 字号只在刻度上：10 只给徽标，11 起是正文层级
  const sizes = new Set([...text.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => m[1]))
  const stray = [...sizes].filter((value) => !['11', '12', '13', '14', '15', '16', '18'].includes(value))
  assert.deepEqual(stray, [], 'font sizes outside the scale')
})

test('borders stay hairline, like the host controls', async () => {
  const text = await source()
  const heavy = [...text.matchAll(/border(?:-top|-bottom|-left|-right)?:\s*1px solid (?!transparent)/g)].map((m) => m[0])
  assert.deepEqual(heavy, [], 'visible borders are .5px, not 1px')
  assert.ok(text.includes('border-radius: var(--dsw-radius-xs); border: .5px solid'), 'the row checkbox keeps its square 4px corner')
  assert.ok(text.includes('outline: var(--dsw-focus-ring-width) solid'), 'focus rings use the host tokens')
})

test('the workspace checkbox selects only the chats the filter shows', async () => {
  const text = await source()
  const start = text.indexOf('const renderGroup = (group)')
  assert.notEqual(start, -1, 'renderGroup exists')
  const group = text.slice(start, text.indexOf('\n      return h(', start))
  assert.ok(group.includes('const selectable = shown.map((row) => row.id)'), 'the selection scope is derived from the filtered rows')
  assert.ok(group.includes('!selectable.includes(id)'), 'deselecting uses the visible set')
  assert.ok(group.includes('[...new Set([...current, ...selectable])]'), 'selecting uses the visible set')
  assert.equal(group.includes('!ids.includes(id)'), false, 'the hidden rows are not part of the checkbox')
  assert.ok(group.includes('String(shown.length)'), 'the header count matches what the list shows')
  assert.ok(group.includes('ask({ ids, workspace: group })'), 'deleting the whole workspace still passes every id it owns')
})

test('the rewind button rides the official user row without replacing it', async () => {
  const text = await source()
  assert.ok(text.includes("slots.entries('conversation.chat.node')"), 'it takes over the registered row entries')
  assert.ok(text.includes("new Set(['user', 'steering'])"), 'only user and steering rows carry the action')
  assert.ok(text.includes('extraActions'), 'the action is injected through the official actions row')
  assert.ok(text.includes('entry.component = replacement'), 'the registered identity is replaced in place')
  assert.ok(text.includes('entry.component = record.original'), 'and restored on unload')
  assert.equal(text.includes("if (typeof buildActions !== 'function') return row"), true, 'an unexpected row shape is returned untouched')
  assert.ok(text.includes("postJson(`${API.rewind}/plan`"), 'the button asks the host for a plan first')
})

test('a rewound span is hidden in the transcript, never deleted', async () => {
  const text = await source()
  assert.ok(text.includes('data-yk-rewind'), 'rows are tagged with their session and seq')
  assert.ok(text.includes("querySelectorAll('[data-chat-flow-key]')"), 'the span walks the transcript rows in order')
  assert.ok(text.includes("row.style.display = 'none'"), 'hiding is a reversible display change')
  assert.ok(text.includes('releaseRewindHiding'), 'teardown restores every row it hid')
  assert.ok(text.includes("postJson(`${API.rewind}/apply`"), 'the confirm calls the host apply endpoint')
  // 样式要能在对话页独立存在：面板没打开时也有按钮样式。
  assert.ok(text.includes('const REWIND_STYLES'), 'the action ships its own stylesheet')
  assert.ok(text.includes("style.setAttribute('data-yk-rewind', '')"), 'the stylesheet is injected on install')
})

test('the rewind action uses host overlays and hides its internal marker', async () => {
  const text = await source()
  assert.ok(text.includes("const primitives = require('@deepseek-ai/dsh-client-ui-primitives')"), 'the native tooltip is available')
  assert.ok(text.includes("const ReactDOM = require('react-dom')"), 'the confirmation can leave the clipped actions row')
  assert.ok(text.includes('const Tooltip = primitives.Tooltip'), 'the tooltip is the host component, not a pseudo-element imitation')
  assert.ok(text.includes('ReactDOM.createPortal('), 'the confirmation is portalled to document.body')
  assert.ok(text.includes("blocks.length === 1 && blocks[0]?.type === 'text' && blocks[0].text === MARKER_TEXT"), 'the marker is recognized by shape and content')
  assert.ok(text.includes('blocks[0].text === MARKER_TEXT) return null'), 'the marker renders no bubble or action without deleting its log event')
  assert.equal(text.includes('.yk-rewindBtn::after'), false, 'no clipped pseudo-element tooltip remains')
  assert.ok(text.includes('.yk-rewindBtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }'), 'hover matches the native copy action')
})

test('panel controls keep one scale at every nesting level', async () => {
  const text = await source()
  const rule = (selector) => {
    const match = new RegExp(`^${selector.replaceAll('.', '\\.')} \\{([^}]*)\\}`, 'm').exec(text)
    assert.notEqual(match, null, `${selector} exists`)
    return match[1]
  }
  assert.ok(rule('.yk-btn-sm').includes('font-size: 13px'), 'small buttons use body-sized text')
  assert.equal(text.includes('.yk-childWrap .yk-check { width: 13px; height: 13px; }'), false, 'nested checkboxes stay 16px')
  assert.equal(text.includes('.yk-childWrap .yk-btn.yk-iconBtn { width: 26px; min-height: 26px; }'), false, 'nested icon buttons stay 28px')
  assert.ok(
    /^\.yk-option input, \.yk-itemMain-row input\[type="checkbox"\] \{ flex: none; width: 16px; height: 16px;/m.test(text),
    'native checkbox options use the same 16px square control',
  )
  assert.ok(text.includes('container-type: inline-size'), 'layout responds to the sidebar width')
  assert.ok(text.includes('@container (max-width: 720px)'), 'desktop windows with a narrow sidebar still collapse')
  assert.ok(rule('.yk-tabPanel, .yk-body').includes('gap: 20px'), 'sections use the shared 20px gap')
  assert.equal(text.includes('min-height: 30px'), false, 'no half-step button height remains')
  assert.equal(text.includes('border: 1px dashed'), false, 'dashed outlines are hairlines too')
})
