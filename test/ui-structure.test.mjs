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
