/**
 * 真实 DOM 用例的执行体（在子进程里跑）。
 *
 * React 的调度器在本仓库的 node:test 进程里退出时会留下一个永不落地的微任务，
 * 直接把 `node --test` 挂住；所以这里用独立进程执行，跑完显式退出，
 * `ui-dom.test.mjs` 只负责拉起它并检查结果。
 *
 * 断言里只放字符串或布尔值，不要把 DOM 节点本身交给 `assert`：节点上挂着 React
 * 的 `__reactFiber$…` 引用，断言失败时 Node 要把它格式化进错误信息，顺着引用能
 * 展开整棵组件树，几百行的列表就足以把内存吃光，测试会变成拖垮机器而不是报错。
 */
import assert from 'node:assert/strict'
import { mountPanel } from './ui-dom-harness.mjs'

const components = Object.fromEntries(
  ['chats', 'sites', 'files', 'rules', 'skills', 'presets', 'proxy', 'github', 'browser', 'purge', 'runtime', 'rewind']
    .map((name) => [name, { at: '2026-11-08T00:00:00.000Z' }]),
)
const routes = {
  '/yukari/api/overview': { ok: true, overview: { version: '1.0.0', pid: 1, components } },
  '/files/api/roots': { ok: true, roots: [{ id: 'w', title: 'w', path: '/workspace' }] },
  '/files/api/list': { ok: true, path: '', entries: [], truncated: false },
  '/chat-manager/api/state': {
    ok: true,
    state: {
      sessions: [{ id: 's1', title: 'S', cwd: '/workspace', workspaceId: 'w1', archived: false, live: true, running: false }],
      workspaces: [{ id: 'w1', title: 'W', path: '/workspace' }],
      totals: { all: 1, active: 1, archived: 0 },
    },
  },
}
const tabOf = (window, key) => window.document.querySelector(`[data-tab="${key}"]`)
const panelOf = (window, key) => window.document.querySelector(`#yukari-panel-${key}`)

async function caseTabs() {
  const panel = mountPanel(routes)
  await panel.renderMain()
  const tabs = [...panel.window.document.querySelectorAll('[role="tab"]')].map((node) => node.dataset.tab)
  assert.deepEqual(tabs, ['overview', 'chats', 'sites', 'files', 'rules', 'skills', 'presets', 'proxy', 'github', 'browser', 'purge', 'runtime'])
  assert.equal(panelOf(panel.window, 'overview')?.hidden, false)
  await panel.close()
}

async function caseKeepAlive() {
  const panel = mountPanel(routes)
  await panel.renderMain()
  const click = async (key) => {
    tabOf(panel.window, key).dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  await click('files')
  assert.equal(panelOf(panel.window, 'files')?.hidden, false, 'the files panel mounts on first visit')
  await click('overview')
  assert.equal(panelOf(panel.window, 'files')?.hidden, true, 'the files panel stays mounted, hidden')
  assert.equal(panelOf(panel.window, 'overview').hidden, false)
  // `hidden` 只是属性：`.yk-tabPanel` 自己的 display:flex 会盖掉浏览器默认样式，
  // 必须由面板的样式表显式写一条，否则访问过的页面会全部显示并堆叠。
  assert.equal(panel.window.getComputedStyle(panelOf(panel.window, 'files')).display, 'none', 'a hidden tab is actually not displayed')
  assert.equal(panel.window.getComputedStyle(panelOf(panel.window, 'overview')).display, 'flex')
  await panel.close()
}

async function caseConfirmFocus() {
  const panel = mountPanel(routes)
  await panel.renderMain()
  const click = async (node) => {
    node.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  await click(tabOf(panel.window, 'chats'))
  const trigger = [...panel.window.document.querySelectorAll('.yk-wsHeader button')]
    .find((node) => node.textContent.includes('cDeleteWorkspace'))
  assert.ok(trigger !== undefined, 'the workspace delete button rendered')
  await click(trigger)
  const dialog = panel.window.document.querySelector('[role="alertdialog"]')
  assert.ok(dialog !== null, 'the confirmation opened')
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  const focused = panel.window.document.activeElement
  assert.equal(focused?.textContent, 'cancel', 'focus lands on the cancel button, not the destructive one')
  const options = [...dialog.querySelectorAll('input[type="checkbox"]')]
  assert.ok(options.length >= 1, 'the file-output option is offered')
  assert.equal(options[0].checked, false, 'deleting the workspace folder is opt-in')
  await panel.close()
}

async function caseChatVisibility() {
  const created = []
  const definition = {
    target: 'chat',
    create() {
      const inner = {
        empty: 'empty',
        last: null,
        replace(input) { this.last = input; return 'replaced' },
        apply(input) { this.last = input; return 'applied' },
        extra() { return 'extra' },
      }
      created.push(inner)
      return inner
    },
  }
  const originalCreate = definition.create
  const panel = mountPanel(routes, {
    services: { uiConversation: { views: { entries: () => [definition], subscribe: () => () => {} } } },
  })
  await panel.renderMain()
  assert.notEqual(definition.create, originalCreate, 'the host view was wrapped')
  const builder = definition.create()
  assert.equal(builder.empty, 'empty', 'plain properties are forwarded')
  assert.equal(builder.extra(), 'extra', 'unknown methods are forwarded')
  const nodes = [
    { key: 'a', anchorSeq: 1, visibility: 'visible' },
    { key: 'b', anchorSeq: 2, visibility: 'visible' },
    { key: 'm', anchorSeq: 5, visibility: 'visible', data: { source: { kind: 'rewind-marker', start: 2 } } },
    { key: 'c', anchorSeq: 6, visibility: 'visible' },
  ]
  assert.equal(builder.replace({ nodes, timeline: null }), 'replaced')
  const replaced = created.at(-1).last.nodes
  assert.deepEqual(replaced.map((node) => node.visibility), ['visible', 'hidden', 'hidden', 'visible'])
  assert.equal(nodes[1].visibility, 'visible', 'the original node objects are untouched')
  assert.equal(builder.apply({ upserts: [{ key: 'x', anchorSeq: 3, visibility: 'visible' }] }), 'applied')
  assert.equal(created.at(-1).last.upserts[0].visibility, 'hidden')
  await panel.close()
  assert.equal(definition.create, originalCreate, 'the host view is restored on unload')
}

async function caseChatCounts() {
  // 一个父会话带一个子会话：子会话在列表里折在父会话下面，计数不该把它算进去。
  const state = {
    sessions: [
      { id: 'parent', title: 'P', cwd: '/workspace', workspaceId: 'w1', workspaceTitle: 'W', archived: false, live: true, running: false, parentSession: null, bytes: 100, updatedAt: Date.now() },
      { id: 'child', title: 'C', cwd: '/workspace', workspaceId: 'w1', workspaceTitle: 'W', archived: false, live: false, running: false, parentSession: 'parent', bytes: 20, updatedAt: Date.now() },
    ],
    workspaces: [{ id: 'w1', title: 'W', path: '/workspace' }],
    totals: { all: 1, active: 1, archived: 0, live: 1, running: 0, bytes: 100 },
  }
  const panel = mountPanel({ ...routes, '/chat-manager/api/state': { ok: true, state } })
  await panel.renderMain()
  tabOf(panel.window, 'chats').dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
  await panel.tick()
  await panel.tick()
  const text = panel.window.document.body.textContent
  // 行里的元信息以前读一个后端不提供的字段，每行显示「undefined 条事件」。
  assert.equal(/undefined/.test(text), false, 'no meta field renders as undefined')
  const chats = panelOf(panel.window, 'chats')
  // 夹具里没有 locale 服务，`t()` 返回键名：一位数走 `cTotalOne`，多位走 `cTotal`。
  assert.equal(chats.querySelector('.yk-foot').textContent, 'cTotalOne', 'the footer counts the top-level chat')
  assert.equal(chats.querySelector('.yk-wsCount').textContent, '1', 'the workspace header counts it once')
  assert.equal(chats.querySelectorAll('.yk-item').length, 1, 'the subagent chat stays folded under its parent')
  await panel.close()
}

async function caseChatPreview() {
  // 悬停会话行 → 240 ms 后拉预览 → 卡片带着标题、轮数与两条对话出现；
  // 移开、或切走标签页，卡片必须收起来（它挂在 body 上，不受标签页 hidden 约束）。
  const state = {
    sessions: [
      { id: 's1', title: '综合聊天讨论', cwd: '/workspace', workspaceId: 'w1', workspaceTitle: 'W', archived: false, live: true, running: false, parentSession: null, bytes: 100, updatedAt: 1 },
    ],
    workspaces: [{ id: 'w1', title: 'W', path: '/workspace' }],
    totals: { all: 1, active: 1, archived: 0, live: 1, running: 0, bytes: 100 },
  }
  const preview = {
    ok: true,
    preview: { id: 's1', live: true, turns: 2, messages: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好，有什么可以帮你的吗？' }] },
  }
  const panel = mountPanel({
    ...routes,
    '/chat-manager/api/state': { ok: true, state },
    '/chat-manager/api/preview': preview,
  })
  await panel.renderMain()
  const click = async (node) => {
    node.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  await click(tabOf(panel.window, 'chats'))
  const row = panelOf(panel.window, 'chats').querySelector('.yk-item')
  assert.ok(row !== null, 'the chat row rendered')

  const hover = () => row.dispatchEvent(new panel.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: panel.window.document.body }))
  const leave = () => row.dispatchEvent(new panel.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: panel.window.document.body }))

  hover()
  assert.equal(panel.window.document.querySelector('.yk-chatPreview')?.textContent ?? null, null, 'nothing opens before the dwell time')
  await new Promise((resolve) => setTimeout(resolve, 320))
  await panel.tick()
  await panel.tick()

  const card = panel.window.document.querySelector('.yk-chatPreview')
  assert.ok(card !== null, 'the card appears after the dwell time')
  assert.equal(card.querySelector('.yk-chatPreviewTitle').textContent, '综合聊天讨论')
  assert.equal(card.querySelector('.yk-chatPreviewMeta').textContent, 'cPreviewTurns', 'the turn count is shown through a locale key')
  assert.deepEqual([...card.querySelectorAll('.yk-chatPreviewText')].map((node) => node.textContent), ['你好', '你好，有什么可以帮你的吗？'])
  assert.equal(card.getAttribute('role'), 'tooltip')

  leave()
  await panel.tick()
  assert.equal(panel.window.document.querySelector('.yk-chatPreview')?.textContent ?? null, null, 'leaving the row closes the card')

  // 卡片开着时切走标签页：卡片跟着收，不能停在一个隐藏的页面上。
  hover()
  await new Promise((resolve) => setTimeout(resolve, 320))
  await panel.tick()
  assert.ok(panel.window.document.querySelector('.yk-chatPreview') !== null)
  await click(tabOf(panel.window, 'overview'))
  assert.equal(panel.window.document.querySelector('.yk-chatPreview')?.textContent ?? null, null, 'switching tabs closes the card')
  await panel.close()
}

async function caseChatPreviewTap() {
  // 触屏没有悬停：点行的空白处打开预览，再点一下必须收起。手机上每次点击前还会补
  // 一次 mouseover（React 的 onMouseEnter 走的就是它），悬停计时不能把刚关掉的卡片
  // 又打开；行内按钮只做自己的事，不顺手切换预览。
  const state = {
    sessions: [{ id: 's1', title: '综合聊天讨论', cwd: '/workspace', workspaceId: 'w1', workspaceTitle: 'W', archived: false, live: true, running: false, parentSession: null, bytes: 100, updatedAt: 1 }],
    workspaces: [{ id: 'w1', title: 'W', path: '/workspace' }],
    totals: { all: 1, active: 1, archived: 0, live: 1, running: 0, bytes: 100 },
  }
  const panel = mountPanel({
    ...routes,
    '/chat-manager/api/state': { ok: true, state },
    '/chat-manager/api/preview': { ok: true, preview: { id: 's1', live: true, turns: 1, messages: [{ role: 'user', text: '你好' }] } },
  })
  await panel.renderMain()
  const click = async (node) => {
    node.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  const card = () => panel.window.document.querySelector('.yk-chatPreview')?.textContent ?? null
  await click(tabOf(panel.window, 'chats'))
  const row = panelOf(panel.window, 'chats').querySelector('.yk-item')
  assert.ok(row !== null, 'the chat row rendered')

  await click(row)
  assert.ok(card() !== null, 'tapping the row opens the preview')

  // 行内的删除按钮有自己的一步确认，点它时卡片保持原样。
  const trash = row.querySelector('.yk-itemActions button[aria-label="cDelete"]')
  assert.ok(trash !== null, 'the row has its own delete button')
  await click(trash)
  assert.ok(card() !== null, 'a row action leaves the preview alone')
  const cancel = [...panel.window.document.querySelectorAll('.yk-itemActionsConfirm button')]
    .find((node) => node.textContent === 'cancel')
  assert.ok(cancel !== undefined, 'the confirmation offers a cancel button')
  await click(cancel)

  // 第二下点击收起卡片，且 240 ms 的悬停计时不会把它重新打开。
  const second = panelOf(panel.window, 'chats').querySelector('.yk-item')
  second.dispatchEvent(new panel.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: panel.window.document.body }))
  await click(second)
  assert.equal(card(), null, 'a second tap on the same row closes the preview')
  await new Promise((resolve) => setTimeout(resolve, 320))
  await panel.tick()
  assert.equal(card(), null, 'the hover timer does not reopen it')
  await panel.close()
}

async function caseChatPreviewGone() {
  // 卡片挂在 body 上，行的存在与否只能自己盯：行被删除、或被隐藏的祖先带走时，
  // 卡片必须立刻收起来，不能等用户滚动才想起来。
  const state = {
    sessions: [{ id: 's1', title: '综合聊天讨论', cwd: '/workspace', workspaceId: 'w1', workspaceTitle: 'W', archived: false, live: true, running: false, parentSession: null, bytes: 100, updatedAt: 1 }],
    workspaces: [{ id: 'w1', title: 'W', path: '/workspace' }],
    totals: { all: 1, active: 1, archived: 0, live: 1, running: 0, bytes: 100 },
  }
  const empty = { sessions: [], workspaces: [{ id: 'w1', title: 'W', path: '/workspace' }], totals: { all: 0, active: 0, archived: 0, live: 0, running: 0, bytes: 0 } }
  const panel = mountPanel({
    ...routes,
    '/chat-manager/api/state': { ok: true, state },
    '/chat-manager/api/preview': { ok: true, preview: { id: 's1', live: true, turns: 1, messages: [{ role: 'user', text: '你好' }] } },
    '/chat-manager/api/delete': { ok: true, state: empty, ids: ['s1'], deleted: 1, filesDeleted: 0, failed: [], notes: [] },
  })
  await panel.renderMain()
  const click = async (node) => {
    node.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  const card = () => panel.window.document.querySelector('.yk-chatPreview')?.textContent ?? null
  await click(tabOf(panel.window, 'chats'))
  const rowOf = () => panelOf(panel.window, 'chats').querySelector('.yk-item')
  // 用悬停打开：这条用例验的是"行消失之后卡片怎么办"，与点击开关无关。
  const open = async () => {
    rowOf().dispatchEvent(new panel.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: panel.window.document.body }))
    await new Promise((resolve) => setTimeout(resolve, 320))
    await panel.tick()
    await panel.tick()
  }

  // 面板被宿主藏起来（行还在文档里，尺寸变成 0）：相交报告一响，卡片就收。
  await open()
  assert.ok(card() !== null, 'the preview opened')
  panel.reportIntersection(false)
  await panel.tick()
  await panel.tick()
  assert.equal(card(), null, 'a hidden panel closes the card')

  // 删除这一行：行从文档里消失，卡片跟着走。
  await open()
  assert.ok(card() !== null, 'the preview opened again')
  await click(rowOf().querySelector('.yk-itemActions button[aria-label="cDelete"]'))
  const confirm = [...panel.window.document.querySelectorAll('.yk-itemActionsConfirm button')].find((node) => node.className.includes('yk-dangerText'))
  assert.ok(confirm !== undefined, 'the row asks for confirmation first')
  await click(confirm)
  const gone = await panel.waitFor(() => card() === null)
  assert.equal(gone, true, 'deleting the row closes the card')
  assert.equal(panelOf(panel.window, 'chats').querySelectorAll('.yk-item').length, 0, 'the row is gone')
  await panel.close()
}

async function caseChatPreviewBelow() {
  // 卡片贴在行下方；下方放不下就翻到上方。无论如何都不能盖住被悬停的那一行，
  // 否则看不到自己正在预览哪一条。
  const state = {
    sessions: [{ id: 's1', title: 'S', cwd: '/workspace', workspaceId: 'w1', workspaceTitle: 'W', archived: false, live: true, running: false, parentSession: null, bytes: 1, updatedAt: 1 }],
    workspaces: [{ id: 'w1', title: 'W', path: '/workspace' }],
    totals: { all: 1, active: 1, archived: 0, live: 1, running: 0, bytes: 1 },
  }
  const panel = mountPanel({
    ...routes,
    '/chat-manager/api/state': { ok: true, state },
    '/chat-manager/api/preview': { ok: true, preview: { id: 's1', live: true, turns: 1, messages: [{ role: 'user', text: 'x' }] } },
  })
  Object.defineProperty(panel.window, 'innerWidth', { value: 1200, configurable: true })
  Object.defineProperty(panel.window, 'innerHeight', { value: 800, configurable: true })
  await panel.renderMain()
  const click = async (node) => {
    node.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  await click(tabOf(panel.window, 'chats'))
  const row = panelOf(panel.window, 'chats').querySelector('.yk-item')
  assert.ok(row !== null, 'the chat row rendered')

  const showAt = (rect) => {
    row.getBoundingClientRect = () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top })
    row.dispatchEvent(new panel.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: panel.window.document.body }))
  }
  const box = async () => {
    await new Promise((resolve) => setTimeout(resolve, 320))
    await panel.tick()
    const card = panel.window.document.querySelector('.yk-chatPreview')
    assert.ok(card !== null, 'the card appeared')
    return { left: parseFloat(card.style.left), top: parseFloat(card.style.top), maxHeight: parseFloat(card.style.maxHeight) }
  }
  const leave = () => row.dispatchEvent(new panel.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: panel.window.document.body }))

  // 行在面板上方：卡片在它下面展开，左边缘与行对齐。
  showAt({ left: 16, right: 296, top: 120, bottom: 156 })
  const belowCard = await box()
  assert.ok(belowCard.top >= 156, 'the card opens below the row')
  assert.equal(belowCard.left, 16, 'and stays aligned with the row instead of floating away')
  leave()
  await panel.tick()

  // 行贴近窗口底部：下方只剩几十像素，卡片翻到上方且整块留在视口里。
  showAt({ left: 16, right: 296, top: 700, bottom: 736 })
  const aboveCard = await box()
  assert.ok(aboveCard.top + aboveCard.maxHeight <= 700, 'a row near the bottom opens the card above it')
  assert.ok(aboveCard.top >= 8, 'and the card stays inside the viewport')
  leave()
  await panel.close()
}

async function caseFilesMarkdown() {
  // 文件预览把 markdown 交给宿主的 MarkdownText。宿主渲染代码块时要读
  // `labels.code.copyLabel`，漏传 labels 会抛 TypeError（reading 'code' of
  // undefined），整个文件页白屏——含代码块的文档一打开就中招。
  const entries = [{ name: 'notes.md', path: 'notes.md', type: 'file', size: 20 }]
  const panel = mountPanel({
    ...routes,
    '/files/api/list': { ok: true, path: '', truncated: false, entries },
    '/files/api/preview': { ok: true, kind: 'text', text: '# T\n\n```bash\necho hi\n```\n', truncated: false },
  })
  await panel.renderMain()
  const click = async (node) => {
    node.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  await click(tabOf(panel.window, 'files'))
  // 列表与预览都是异步请求；并行跑测试文件时两个 tick 不一定够，按结果等。
  const waitFor = async (read) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = read()
      if (found !== undefined && found !== null) return found
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return null
  }
  const title = await waitFor(() => [...panelOf(panel.window, 'files').querySelectorAll('.yk-itemTitle')]
    .find((node) => node.textContent === 'notes.md'))
  assert.ok(title !== null, 'the markdown file is listed')
  await click(title)
  const code = await waitFor(() => panelOf(panel.window, 'files').querySelector('.yk-previewDoc [data-markdown-code]'))
  assert.ok(code !== null, 'a markdown file with a fenced block renders through the host viewer')
  assert.equal(code.getAttribute('data-markdown-code'), 'copy', 'the code block receives its copy label')
  await panel.close()
}

async function caseProbeNote() {
  // 自检接口的答案是一层信封里的 `probe`：`ok: false` 在里面表示"没有可自检的
  // 会话"，是查询成功的答案。接口要是把 `ok: false` 当信封直接发出来，面板会把
  // 它当 HTTP 错误，只显示一句「HTTP 200」。
  const routesWithProbe = {
    ...routes,
    '/purge/api/config': {
      ok: true,
      presetRegistered: true,
      isCustom: false,
      prompt: 'PROMPT',
      defaultPrompt: 'PROMPT',
      settings: { anchor: true, refusalRetry: true, stripHostLimits: true },
      stats: { assembled: 0, injected: 0, stripped: 0, scrubbed: 0, tools: 0, retried: 0, skipped: 0, sessions: 0, lastAt: null, recent: [] },
    },
    '/purge/api/probe': { ok: true, probe: { ok: false, reason: 'not-live', sessionId: 'nope' } },
  }
  const panel = mountPanel(routesWithProbe)
  await panel.renderMain()
  const click = async (node) => {
    node.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  await click(tabOf(panel.window, 'purge'))
  const trigger = [...panel.window.document.querySelectorAll('button')].find((node) => node.textContent === 'gProbe')
  assert.ok(trigger !== undefined, 'the self-check button rendered')
  await click(trigger)
  const text = panelOf(panel.window, 'purge').textContent
  assert.ok(text.includes('gProbeFail'), 'the answer is shown as a self-check note')
  assert.equal(text.includes('HTTP 200'), false, 'a self-check answer is not reported as an HTTP error')
  await panel.close()
}

async function caseRestartWatch() {
  // 更新后第一次探测仍可能由旧进程回答。只有启动标识变化才能刷新，否则页面
  // 会在真正的重启之前退回旧界面，看起来就像「重启按钮没反应」。
  let bootId = 'boot-old'
  const overview = () => ({ ok: true, overview: { version: '1.0.0', pid: 1, bootId, components } })
  const panel = mountPanel({
    ...routes,
    '/yukari/api/overview': overview,
    '/yukari/api/update': (_url, init) => init?.method === 'POST'
      ? { ok: true, updated: true, installed: '1.0.1', restarted: false, update: { installed: '1.0.1', pendingRestart: true } }
      : { ok: true, update: { latest: '1.0.1', available: true, updatable: true, pendingRestart: false } },
    '/dshctl/api/restart': { ok: true, scheduled: true, strategy: 'execve' },
  })
  await panel.renderMain()
  const click = async (node) => {
    node.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  const button = (text) => [...panel.window.document.querySelectorAll('button')].find((node) => node.textContent === text)
  await click(button('upCheck'))
  await click(button('upNow'))
  await click(button('upRestart'))
  assert.equal(panel.window.document.querySelector('.yk-overlayTitle')?.textContent, 'rRestarting')
  await new Promise((resolve) => setTimeout(resolve, 3200))
  assert.equal(panel.window.document.querySelector('.yk-overlayTitle')?.textContent, 'rRestarting', 'the old boot answering 200 is not a completed restart')
  bootId = 'boot-new'
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.equal(panel.window.document.querySelector('.yk-overlayTitle')?.textContent, 'rBack', 'a different boot completes the wait')
  await panel.close()
}

async function caseRestartResume() {
  // 更新插件会换掉 client.js，客户端模块随之重载、面板重建。"正在重启"必须活过
  // 这次重建：重载之后直接回到等待界面，看到新进程就刷新，不需要再点任何按钮。
  let bootId = 'boot-old'
  // 核对要发一次真实的请求。这里把它按在一个可控的 promise 上：不按的话，核对
  // 可能在 renderMain 返回之前就结束，而 React 提交到 DOM 的层数又不固定，断言
  // 就变成在赌调度顺序——CI 上正是这样红的。
  let releaseOverview = () => {}
  const gate = new Promise((resolve) => { releaseOverview = resolve })
  const panel = mountPanel(
    {
      ...routes,
      '/yukari/api/overview': async () => {
        await gate
        return { ok: true, overview: { version: '1.0.0', pid: 1, bootId, components } }
      },
    },
    {
      seed: (window) => window.localStorage.setItem('yukari-dsh-plugin:restarting', JSON.stringify({ at: Date.now(), bootId: 'boot-old' })),
    },
  )
  const title = () => panel.window.document.querySelector('.yk-overlayTitle')?.textContent ?? null
  await panel.renderMain()
  // 等待界面要等核对本身走完一轮：意图先跟当前进程的启动标识对上，才会接过去。
  assert.equal(title(), null, 'the wait is not shown before the intent is verified')
  releaseOverview()
  assert.ok(await panel.waitFor(() => title() === 'rRestarting'), 'the reloaded panel resumes waiting instead of showing the tabs')
  await new Promise((resolve) => setTimeout(resolve, 3200))
  assert.equal(title(), 'rRestarting', 'the same boot is not a restart')
  bootId = 'boot-new'
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.equal(title(), 'rBack', 'a new boot finishes the wait by itself')
  assert.equal(panel.window.localStorage.getItem('yukari-dsh-plugin:restarting'), null, 'the intent is cleared once it completes')
  await panel.close()
}

async function caseGithubSigning() {
  // 提交签名是 Host 侧的能力，但按钮、状态与公钥都在面板上；这里确认它们真的接
  // 到了对应的接口，而不是只渲染了一张空卡片。
  const off = {
    configured: true,
    host: 'github.com',
    account: { login: 'octocat', name: '', avatarUrl: '', htmlUrl: '', tokenType: 'fine-grained', scopes: [], expiresAt: null, expired: false, verifiedAt: null },
    git: {
      available: true,
      version: '2.39.5',
      helperInstalled: true,
      includePath: '/home/u/gitconfig',
      tokenFile: '/home/u/token',
      signingEnabled: false,
      identity: { name: 'Tester', email: 'tester@example.com' },
      error: null,
    },
    signing: { enabled: false, keyFile: '/home/u/signing-key', publicKey: null, fingerprint: null, registered: false, registeredAt: null, error: null },
    updatedAt: null,
  }
  const on = {
    ...off,
    git: { ...off.git, signingEnabled: true },
    signing: {
      enabled: true,
      keyFile: '/home/u/signing-key',
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample yukari-dsh-plugin',
      fingerprint: 'SHA256:examplefingerprint',
      registered: true,
      registeredAt: '2026-01-01T00:00:00.000Z',
      error: null,
    },
  }
  // 令牌缺 `admin:ssh_signing_key` 时自动登记会被拒：密钥已经在本地，面板必须给出
  // 公钥与手动添加的入口，而不是一句失败。
  const rejected = {
    ...on,
    signing: { ...on.signing, registered: false, registeredAt: null, error: '令牌无访问权限（GitHub 403）' },
  }
  const manual = {
    ...on,
    signing: { ...on.signing, registered: true, manual: true, registeredAt: '2026-01-02T00:00:00.000Z', error: null },
  }
  const posts = []
  let nextState = on
  const panel = mountPanel({
    ...routes,
    '/github/api/state': { ok: true, state: off },
    '/github/api/enable-signing': () => { posts.push('enable'); return { ok: true, state: nextState } },
    '/github/api/disable-signing': () => { posts.push('disable'); return { ok: true, state: off } },
    '/github/api/signing-manual': () => { posts.push('manual'); return { ok: true, state: manual } },
  })
  await panel.renderMain()
  const click = async (node) => {
    node.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  await click(tabOf(panel.window, 'github'))
  const github = panelOf(panel.window, 'github')
  const button = (text) => [...github.querySelectorAll('button')].find((node) => node.textContent === text)

  assert.ok(github.textContent.includes('ghSign'), 'the signing card rendered')
  assert.ok(button('ghSignEnable') !== undefined, 'signing starts off')
  await click(button('ghSignEnable'))
  assert.ok(await panel.waitFor(() => github.textContent.includes('ghSignRegisteredYes')), 'the registration is shown')
  assert.equal(github.textContent.includes('ghSignEnable'), false, 'the enable button gives way to the key')
  assert.equal(github.querySelector('textarea')?.value ?? null, null, 'a registered key needs no manual step')
  assert.ok(github.textContent.includes('SHA256:examplefingerprint'), 'the fingerprint is shown')
  assert.ok(github.textContent.includes('Tester <tester@example.com>'), 'the global identity is shown next to the key')

  await click(button('ghSignDisable'))
  assert.ok(github.textContent.includes('ghSignDisableTitle'), 'disabling asks first')
  await click(button('ghSignDisableConfirm'))
  assert.ok(await panel.waitFor(() => button('ghSignEnable') !== undefined), 'signing is off again')
  assert.deepEqual(posts, ['enable', 'disable'], 'each button hits its own endpoint')

  nextState = rejected
  await click(button('ghSignEnable'))
  assert.ok(await panel.waitFor(() => github.textContent.includes('ghSignRegisteredNo')), 'a refused registration is visible')
  assert.ok(github.textContent.includes('令牌无访问权限（GitHub 403）'), 'the reason is shown')
  assert.equal(github.querySelector('textarea')?.value, on.signing.publicKey, 'the public key is offered for a manual upload')
  assert.ok(github.textContent.includes('ghSignRetry'), 'the registration can be retried')

  // 公钥已经手动加到账号上：点「已添加」后状态变成手动登记，不再要求重新登记。
  await click(button('ghSignAdded'))
  assert.ok(await panel.waitFor(() => github.textContent.includes('ghSignRegisteredManual')), 'the manual registration is recorded')
  assert.equal(github.querySelector('textarea') !== null, false, 'the manual block closes')
  assert.equal(button('ghSignAdded'), undefined, 'the confirmation is not offered again')
  assert.deepEqual(posts, ['enable', 'disable', 'enable', 'manual'], 'the confirmation hits its own endpoint')
  await panel.close()
}

async function caseUpdateApplies() {
  // HMR 已经运行新版时，更新到此完成；不能再给出一次多余的重启操作。
  const posts = []
  const panel = mountPanel({
    ...routes,
    '/yukari/api/overview': () => ({ ok: true, overview: { version: '1.0.0', pid: 1, bootId: 'boot-old', components } }),
    '/yukari/api/update': (_url, init) => {
      if (init?.method !== 'POST') return { ok: true, update: { latest: '1.0.1', available: true, updatable: true, pendingRestart: false } }
      posts.push(JSON.parse(init.body))
      return { ok: true, updated: true, installed: '1.0.1', restarted: false, update: { installed: '1.0.1', available: false, pendingRestart: false } }
    },
  })
  await panel.renderMain()
  const click = async (node) => {
    node.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  const button = (text) => [...panel.window.document.querySelectorAll('button')].find((node) => node.textContent === text)
  await click(button('upCheck'))
  await click(button('upNow'))
  assert.deepEqual(posts, [{ restart: true }], '仍允许 Host 在必须重启时完成同一次操作')
  assert.equal(panel.window.document.querySelector('.yk-updateText')?.textContent, 'upDone', '更新结果显示为已经生效')
  assert.equal(button('upRestart') !== undefined, false, '热更新完成后不再提供重启按钮')
  assert.equal(panel.window.document.querySelector('.yk-overlayTitle')?.textContent ?? null, null, '热更新不进入进程重启等待')
  assert.equal(panel.window.localStorage.getItem('yukari-dsh-plugin:restarting'), null, '热更新不写入重启意图')
  await panel.close()
}

async function caseUpdateRestarts() {
  // 点一次「更新」就该走完：装上、重启、页面自己回来，不再出现「装好了，请再点重启」。
  const posts = []
  const panel = mountPanel({
    ...routes,
    '/yukari/api/overview': () => ({ ok: true, overview: { version: '1.0.0', pid: 1, bootId: 'boot-old', components } }),
    '/yukari/api/update': (_url, init) => {
      if (init?.method !== 'POST') return { ok: true, update: { latest: '1.0.1', available: true, updatable: true, pendingRestart: false } }
      posts.push(JSON.parse(init.body))
      return { ok: true, updated: true, installed: '1.0.1', restarted: true, update: { installed: '1.0.1', available: false, pendingRestart: true } }
    },
  })
  await panel.renderMain()
  const click = async (node) => {
    node.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
    await panel.tick()
    await panel.tick()
  }
  const button = (text) => [...panel.window.document.querySelectorAll('button')].find((node) => node.textContent === text)
  await click(button('upCheck'))
  await click(button('upNow'))
  assert.deepEqual(posts, [{ restart: true }], 'the update asks the host to restart in the same request')
  assert.equal(panel.window.document.querySelector('.yk-overlayTitle')?.textContent, 'rRestarting', 'the update goes straight to the restart wait')
  const saved = JSON.parse(panel.window.localStorage.getItem('yukari-dsh-plugin:restarting') ?? 'null')
  assert.equal(saved?.bootId, 'boot-old', 'the intent is stored so a reload can resume it')
  await panel.close()
}

async function caseRestartAlreadyDone() {
  // 安装新版本会先重载客户端模块，整页刷新也可能发生在重启完成之后。这时落盘的
  // 意图属于一个已经不存在的进程：打开面板不该再显示一次「正在重启」，更不该
  // 再刷新一次——重启早就完成了。
  const panel = mountPanel(
    {
      ...routes,
      '/yukari/api/overview': () => ({ ok: true, overview: { version: '1.0.0', pid: 1, bootId: 'boot-new', components } }),
    },
    {
      seed: (window) => window.localStorage.setItem('yukari-dsh-plugin:restarting', JSON.stringify({ at: Date.now(), bootId: 'boot-old' })),
    },
  )
  await panel.renderMain()
  await panel.tick()
  assert.equal(panel.window.document.querySelector('.yk-overlayTitle')?.textContent ?? null, null, 'a finished restart does not show the wait again')
  assert.equal(panelOf(panel.window, 'overview')?.hidden, false, 'the panel is usable right away')
  assert.equal(panel.window.localStorage.getItem('yukari-dsh-plugin:restarting'), null, 'the stale intent is dropped')
  // 等待界面没有出现，轮询也就没启动：等过它认出新进程所需的时间，仍然没有界面跳动。
  await new Promise((resolve) => setTimeout(resolve, 3300))
  assert.equal(panel.window.document.querySelector('.yk-overlayTitle')?.textContent ?? null, null, 'the second reload never happens')
  assert.equal(panelOf(panel.window, 'overview')?.hidden, false, 'the panel stays on screen')
  await panel.close()
}

async function caseRuntimeRollback() {
  // 装上去的版本没成为当前运行的版本时，面板要说明并给出回到上一版的入口；
  // 否则用户只会看到一个既不是旧的也不是新的版本号。
  const posts = []
  const state = {
    runtime: { version: '0.2.2-rc.2', pid: 1, node: 'v24.22.2', channel: 'rc', uptimeSec: 60, uptime: '1m' },
    disk: { version: '0.2.2-rc.2', stale: false, error: null },
    update: { latest: '0.2.2-rc.3', checkedAt: '2026-11-14T00:00:00.000Z', available: true },
    restart: { mode: 'auto', strategy: 'execve', delayMs: 800 },
    lastUpdate: { from: '0.2.1-rc.5', to: '0.2.2-rc.3', at: '2026-11-14T00:00:00.000Z', applied: false },
    lastAction: null,
    busy: null,
  }
  const panel = mountPanel({
    ...routes,
    '/dshctl/api/state': { ok: true, state },
    '/dshctl/api/update': (_url, init) => {
      posts.push(JSON.parse(String(init?.body ?? '{}')))
      return { ok: true, target: '0.2.1-rc.5', installed: '0.2.1-rc.5', changed: true, restarted: true, state }
    },
  })
  await panel.renderMain()
  tabOf(panel.window, 'runtime').dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
  const page = () => panel.window.document.querySelector('#yukari-panel-runtime')
  assert.equal(await panel.waitFor(() => (page()?.textContent ?? '').includes('rUpgradeMissed')), true, 'a missed update is stated, not hidden')
  const rollback = [...(page()?.querySelectorAll('button') ?? [])].find((node) => node.textContent === 'rRollback')
  assert.ok(rollback !== undefined, 'the previous version offers a way back')
  rollback.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
  assert.equal(await panel.waitFor(() => posts.length === 1), true, 'the rollback installs that exact version')
  assert.deepEqual(posts[0], { version: '0.2.1-rc.5', restart: true }, 'a rollback also restarts, in the same request')
  assert.equal(
    await panel.waitFor(() => panel.window.document.querySelector('.yk-overlayTitle')?.textContent === 'rRestarting'),
    true,
    'the rollback goes straight to the restart wait',
  )
  await panel.close()
}

async function caseSkills() {
  // 技能页的三件事必须真的接到接口上：行按状态渲染、停用发的是 disable、编辑拿到的是正文。
  const skill = {
    key: 'demo-skill',
    form: 'file',
    state: 'enabled',
    name: 'demo-skill',
    description: 'A demo skill.',
    whenToUse: '',
    modelInvocable: true,
    userInvocable: true,
    path: '/home/u/.dsh/skills/demo-skill.md',
    size: 84,
    mtime: 1794375538352,
    problem: null,
    detail: null,
  }
  const broken = {
    ...skill,
    key: 'broken-skill',
    form: 'bundle',
    state: 'disabled',
    name: 'broken-skill',
    description: '',
    problem: 'missing-description',
    detail: '前言缺少 description。',
  }
  let items = [skill, broken]
  const posts = []
  const panel = mountPanel({
    ...routes,
    '/skills/api/state': () => ({
      ok: true,
      root: '/home/u/.dsh/skills',
      disabledRoot: '/home/u/.dsh/skills-disabled',
      items,
      limits: { uploadMb: 16, textKb: 256, entries: 500 },
    }),
    '/skills/api/skill': () => ({ ok: true, item: skill, text: '---\nname: demo-skill\ndescription: A demo skill.\n---\n', truncated: false }),
    '/skills/api/disable': (_url, init) => {
      posts.push(JSON.parse(String(init?.body ?? '{}')))
      items = items.map((item) => (item.key === 'demo-skill' ? { ...item, state: 'disabled' } : item))
      return { ok: true, item: { ...skill, state: 'disabled' } }
    },
  })
  await panel.renderMain()
  // 总览的技能一行要说清「启用几条 / 共几条」，只给启用数会让人以为被跳过的条目不存在。
  const skillsCard = () =>
    [...panel.window.document.querySelectorAll('.yk-service')].find((node) => node.querySelector('.yk-serviceTitle')?.textContent === 'compSkills') ?? null
  assert.equal(
    await panel.waitFor(() => skillsCard()?.querySelector('.yk-serviceValue')?.textContent === 'ovSkills'),
    true,
    'the row counts enabled against the total',
  )

  tabOf(panel.window, 'skills').dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
  const page = () => panel.window.document.querySelector('#yukari-panel-skills')
  assert.equal(await panel.waitFor(() => page()?.hidden === false), true, 'the skills panel mounts')
  assert.equal(await panel.waitFor(() => (page()?.textContent ?? '').includes('demo-skill')), true, 'the first row renders')
  const text = () => page()?.textContent ?? ''
  assert.ok(text().includes('A demo skill.'), 'the row carries the description')
  assert.ok(text().includes('skUnloadable'), 'a skill the host would skip is flagged, not hidden')
  assert.ok(text().includes('skDisabled'), 'a disabled skill is listed with its state')
  assert.equal(page()?.querySelector('input[type="file"]')?.getAttribute('accept'), '.md,.zip', 'the upload picker accepts both shapes')
  assert.ok(text().includes('/home/u/.dsh/skills'), 'the footer names the root the host scans')

  const buttonIn = (row, label) => [...(row?.querySelectorAll('button') ?? [])].find((node) => node.textContent === label)
  const rows = () => [...(page()?.querySelectorAll('.yk-itemWrap') ?? [])]
  const disableButton = buttonIn(rows()[0], 'skDisable')
  assert.ok(disableButton !== undefined, 'the enabled row offers 停用')
  disableButton.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
  assert.equal(await panel.waitFor(() => posts.length === 1), true, 'the disable request is sent')
  assert.deepEqual(posts[0], { key: 'demo-skill', form: 'file' }, 'disabling posts the entry identity')
  // 重新加载落地后，这一行的动作从「停用」换成「启用」，按钮也重新可用。
  const enableButton = () => buttonIn(rows()[0], 'skEnable')
  assert.equal(
    await panel.waitFor(() => enableButton() !== undefined && enableButton().disabled === false),
    true,
    'the row offers the opposite action once the reload lands',
  )

  const editButton = buttonIn(rows()[0], 'skEdit')
  editButton.dispatchEvent(new panel.window.MouseEvent('click', { bubbles: true }))
  assert.equal(await panel.waitFor(() => page()?.querySelector('textarea') != null), true, 'the editor opens')
  assert.equal(page()?.querySelector('textarea')?.value, '---\nname: demo-skill\ndescription: A demo skill.\n---\n', 'the editor holds the file body')
  const save = buttonIn(page(), 'save')
  assert.equal(save?.disabled, true, 'saving an unchanged body is not offered')
  await panel.close()
}

async function casePickerMemory() {
  const calls = []
  const workspace = {
    openSession: () => {},
    async listDirectory(path) {
      calls.push(path)
      return { path, home: '/home/node', crumbs: [], entries: [], truncated: false }
    },
  }
  const panel = mountPanel(routes, { uiWorkspace: workspace })
  // 面板替换的是 ctx.uiWorkspace 上的方法，所以从挂载结果里取回来调用。
  await panel.picker.listDirectory(undefined)
  assert.equal(calls.at(-1), undefined, '还没有记忆时走宿主默认（主目录）')
  await panel.picker.listDirectory('/workspace/foo')
  await panel.picker.listDirectory('/workspace')
  assert.equal(
    panel.window.localStorage.getItem('yukari-dsh-plugin:picker-directory'),
    '/workspace/foo',
    '父级只用来撑两栏，不覆盖记忆',
  )
  await panel.picker.listDirectory(undefined)
  assert.equal(calls.at(-1), '/workspace/foo', '再次打开从上次停留的目录开始')
  await panel.close()
  await panel.picker.listDirectory(undefined)
  assert.equal(calls.at(-1), undefined, '面板卸载后还原宿主行为')
}

async function casePickerMemorySeeded() {
  const calls = []
  const workspace = {
    openSession: () => {},
    async listDirectory(path) {
      calls.push(path)
      return { path, home: '/home/node', crumbs: [], entries: [], truncated: false }
    },
  }
  const panel = mountPanel(routes, {
    uiWorkspace: workspace,
    seed: (window) => window.localStorage.setItem('yukari-dsh-plugin:picker-directory', '/workspace/bar'),
  })
  await panel.picker.listDirectory(undefined)
  assert.equal(calls.at(-1), '/workspace/bar', '页面重载后仍从记忆的目录开始')
  await panel.close()
}

const cases = [['tabs', caseTabs], ['keep-alive', caseKeepAlive], ['confirm-focus', caseConfirmFocus], ['chat-counts', caseChatCounts], ['chat-preview', caseChatPreview], ['chat-preview-below', caseChatPreviewBelow], ['chat-preview-tap', caseChatPreviewTap], ['chat-preview-gone', caseChatPreviewGone], ['files-markdown', caseFilesMarkdown], ['probe-note', caseProbeNote], ['restart-watch', caseRestartWatch], ['update-applies', caseUpdateApplies], ['update-restarts', caseUpdateRestarts], ['restart-resume', caseRestartResume], ['restart-already-done', caseRestartAlreadyDone], ['runtime-rollback', caseRuntimeRollback], ['chat-visibility', caseChatVisibility], ['github-signing', caseGithubSigning], ['skills', caseSkills], ['picker-memory', casePickerMemory], ['picker-memory-seeded', casePickerMemorySeeded]]
for (const [name, run] of cases) {
  await run()
  process.stdout.write(`ok ${name}\n`)
}
process.exit(0)
