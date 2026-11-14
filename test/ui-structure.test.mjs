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

test('cards carry state and actions, not feature prose', async () => {
  const text = await source()
  // 常驻功能说明搬进了 rules.md：面板里只有一次性操作步骤还留在卡片上。
  for (const key of ['bDesc', 'kDesc', 'gDesc']) {
    assert.equal(text.includes(`${key}:`), false, `${key} is gone from both dictionaries`)
  }
  const limits = {
    zh: { pIntro: 40, pTrust: 30, ghSecurityHint: 60, ghStepAccess: 60, ghStorage: 40, pChooseTemplateHint: 30 },
    en: { pIntro: 60, pTrust: 45, ghSecurityHint: 120, ghStepAccess: 100, ghStorage: 60, pChooseTemplateHint: 50 },
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

test('the tab strip fades its edges and carries no extra controls', async () => {
  const text = await source()
  // 边缘只靠遮罩渐隐，两端都不放按钮：滚到哪一侧由滚动位置决定。
  const bar = /^\.yk-navBar \{[^}]*\}$/m.exec(text)?.[0] ?? ''
  assert.ok(bar.includes('mask-image: linear-gradient(90deg'), 'both edges fade into the page')
  assert.ok(bar.includes('--yk-navFadeL'), 'the left fade width is a variable')
  assert.ok(text.includes("bar.style.setProperty('--yk-navFadeR'"), 'the right fade follows the scroll position')
  assert.equal(text.includes('yk-navArrow'), false, 'no arrow buttons sit on the strip')
  assert.equal(text.includes('yk-navScrim'), false, 'no scrim layer either')
})

test('the panel says so when the host reports a degraded snapshot', async () => {
  const text = await source()
  // 宿主已经把这些字段放在 payload 里；面板不读，用户就只能看到"一切正常"。
  assert.ok(text.includes('config?.workspacesDegraded'), 'a fallback workspace list is visible')
  assert.ok(text.includes('data?.warnings ?? []'), 'chat snapshot warnings are visible')
  assert.ok(text.includes("payload.truncated === true"), 'a truncated listing is carried into state')
  assert.ok(text.includes("fill(t('fTruncated'), { n: listing.limit })"), 'the listing cap is named, not hardcoded')
})

test('every row-level delete confirms inside its own actions', async () => {
  const text = await source()
  const inline = (text.match(/'yk-itemActions yk-itemActionsConfirm'/g) ?? []).length
  assert.equal(inline, 5, 'chats, sites, proxy, skills and presets each swap their actions for the confirm')
  assert.ok(text.includes('function ConfirmActions'), 'the row confirm is the shared inline component')
  assert.ok(text.includes('function ConfirmStrip'), 'card-level destructive actions keep their block confirm')
  assert.equal(text.includes('yk-confirmWrap'), false, 'no leftover wrapper for the old row block')
})

test('panel layout lives in the stylesheet, not in inline style attributes', async () => {
  const text = await source()
  // 行内 style 只留给随数据变化的尺寸（进度、logo 边长）；其余一律走样式类。
  const inline = text.match(/style: \{[^}]*\}/g) ?? []
  assert.ok(inline.length > 0, 'the scan found the inline styles')
  // 浮层的位置与尺寸只能由 getBoundingClientRect() 算出来，写成裸标识符也算数据驱动；
  // 但静态的宽高、内边距这些仍然必须在样式表里。
  const FLOATING = new Set(['left', 'top', 'right', 'bottom', 'width', 'maxHeight', 'maxWidth'])
  const staticSizes = (value) => {
    if (value.includes('${')) return false
    const keys = value.replace(/^style: \{/, '').replace(/\}$/, '').split(',').map((part) => part.split(':')[0].trim())
    return keys.some((key) => !FLOATING.has(key))
  }
  assert.deepEqual(inline.filter(staticSizes), [], 'static sizes belong in the stylesheet')
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
  // 列表里只铺一级会话（子会话折在父会话下面），计数也按一级会话算。
  assert.ok(group.includes('String(roots.length)'), 'the header count matches the rows the list lays out')
  assert.ok(group.includes('ask({ ids, workspace: group })'), 'deleting the whole workspace still passes every id it owns')
})

test('the chat counts ignore the subagent chats nested under a parent', async () => {
  const text = await source()
  assert.ok(
    text.includes("counted(t, 'cTotalOne', 'cTotal', visible.filter((row) => row.parentSession === null).length)"),
    'the footer counts the top-level chats the filter shows',
  )
  // 后端快照没有事件计数：面板读它只会显示 undefined。
  assert.equal(text.includes("t('cEvents')"), false, 'the row meta carries no event count')
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

test('interactive body portals declare a macOS window exclusion', async () => {
  const text = await source()
  // macOS Desktop 只免除 data-window-drag 行内控件的拖拽，body 上的浮层没有布局盒、
  // 得自己声明可视区域，否则按住浮层里的按钮会拖动窗口。
  const exclusions = (text.match(/'data-window-drag-exclude': ''/g) ?? []).length
  assert.equal(exclusions, 2, 'the rewind panel and the image lightbox both carry the exclusion')
  // 会话悬停预览是 pointer-events: none 的纯展示卡片，不构成可交互视口。
  assert.ok(text.includes('text-align: left; pointer-events: none;'), 'the chat preview stays non-interactive')
})

test('a rewind always puts the files back, with no opt-out checkbox', async () => {
  const text = await source()
  // 操作者确认过的行为：回撤就还原文件，不再问「同时还原文件」。
  assert.ok(text.includes('${API.rewind}/apply`, { sessionId, seq, restoreFiles: true'), 'the panel always asks for the files back')
  assert.equal(text.includes('rwRestoreFiles'), false, 'no locale key for a checkbox that no longer exists')
  const calls = [...text.matchAll(/restoreFiles:\s*(\w+)/g)].map((match) => match[1])
  assert.deepEqual(calls, ['true'], 'every rewind the panel starts asks for the files back')
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
