/**
 * 把真实 `client.js` 挂到 jsdom 上跑。
 *
 * 这是对既有 UI 用例的补强：那些用例是对源码做字符串匹配（改缩进会红、布局
 * 真的塌了不红）。这里用宿主同款的模块加载方式喂进 React，只替换宿主才能真正
 * 提供的东西（locale、slots、primitives），组件本身一行不抄。
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import React from 'react'
import ReactDOMClient from 'react-dom/client'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 面板文案：用键名当文本，断言只依赖结构。 */
const translate = (key) => key

/** 一个能把 `/xxx/api/...` 映射到固定 JSON 的假 fetch。 */
function fakeFetch(routes) {
  return async (url, init) => {
    const target = String(url)
    for (const [prefix, route] of Object.entries(routes)) {
      if (!target.includes(prefix)) continue
      const body = typeof route === 'function' ? await route(target, init) : route
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => body,
      }
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: false, error: `no stub for ${target}` }),
    }
  }
}

/**
 * 载入面板并返回宿主侧的注册结果。
 * @param routes - `fetch` 的桩路由。
 * @returns `{ window, container, renderMain, registrations }`。
 */
export function mountPanel(routes = {}, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' })
  const { window } = dom
  const container = window.document.getElementById('root')

  // 宿主真正提供的全局对象；jsdom 缺的那几个给最小实现。
  globalThis.window = window
  globalThis.document = window.document
  globalThis.localStorage = window.localStorage
  globalThis.fetch = fakeFetch(routes)
  globalThis.MutationObserver = window.MutationObserver
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle)
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // jsdom 没有布局，IntersectionObserver 也缺：用桩记下观察目标，让用例手动触发
  // 浏览器里"祖先被隐藏、元素尺寸归零"的那一刻。
  const intersecting = []
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback
      this.targets = []
      intersecting.push(this)
    }
    observe(target) {
      this.targets.push(target)
    }
    unobserve(target) {
      this.targets = this.targets.filter((node) => node !== target)
    }
    disconnect() {
      this.targets = []
    }
  }
  /** 让所有仍在观察的 IntersectionObserver 报告一次相交状态。 */
  const reportIntersection = (isIntersecting) => {
    for (const observer of intersecting) {
      if (observer.targets.length === 0) continue
      observer.callback(observer.targets.map((target) => ({ target, isIntersecting })), observer)
    }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = false

  // 面板挂载前的一次性准备：用例可以在这里预置 localStorage，模拟页面重载后的状态。
  options.seed?.(window)

  const captured = { module: null }
  window.__ModuleLoader__ = { load: (module) => { captured.module = module } }
  const source = readFileSync(path.join(root, 'client.js'), 'utf8')
  // 文件只做注册，真正的组件在 factory 里创建；按脚本执行，避免包成函数体。
  vm.runInThisContext(source, { filename: 'client.js' })
  if (captured.module === null) throw new Error('client.js did not register a module')

  const primitives = {
    Tooltip: ({ children }) => children,
    // 宿主的 MarkdownText 渲染 fenced code 时读 `labels.code.copyLabel`；
    // 少传 labels 就是线上那个 TypeError（reading 'code' of undefined）。
    MarkdownText: ({ text, labels }) => /^```/m.test(text)
      ? React.createElement('div', { 'data-markdown-code': labels.code.copyLabel }, text)
      : React.createElement('div', null, text),
  }
  const requireForClient = (id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return { createPortal: (children, node) => React.createElement(React.Fragment, null, children) }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require(${id})`)
  }
  const module = captured.module.factory(requireForClient)
  const registrations = new Map()
  const disposers = []
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => translate,
    },
    slots: {
      inject: (_slot, callback) => { callback(); return () => {} },
      register: (definition, component) => {
        registrations.set(definition.key ?? definition.name ?? definition.id, component)
        return () => {}
      },
    },
    // 宿主总是带 listDirectory：缺少它会让面板对每个用例都报一次降级警告。
    uiWorkspace: {
      openSession: () => {},
      listDirectory: async () => ({ path: '', home: '', crumbs: [], entries: [], truncated: false }),
      ...options.uiWorkspace,
    },
    get: (name) => options.services?.[name],
    inject: (names, callback) => { callback({ get: (name) => options.services?.[name] }); return () => {} },
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => disposer?.()
    },
    logger: { warn: () => {}, info: () => {} },
    get: () => undefined,
  }
  for (const name of module.inject ?? []) {
    if (!(name in ctx)) ctx[name] = {}
  }
  module.apply(ctx)
  const Main = registrations.get('yukari')
  if (Main === undefined) throw new Error('the panel slot was not registered')

  const reactRoot = ReactDOMClient.createRoot(container)
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  /**
   * Wait for a condition to hold.
   *
   * React commits through its own scheduler, so the number of macrotask hops
   * between a state change and the DOM patch is not fixed. Asserting after a
   * counted number of `tick()` calls therefore races the scheduler; poll a
   * condition instead and let the case report what it expected on timeout.
   * @returns whether the condition held before the timeout.
   */
  const waitFor = async (condition, { timeout = 2000, step = 10 } = {}) => {
    const deadline = Date.now() + timeout
    for (;;) {
      if (condition()) return true
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, step))
    }
  }
  const renderMain = async () => {
    reactRoot.render(React.createElement(Main, {}))
    await tick()
    await tick()
  }
  const close = async () => {
    // 先跑组件自己的 disposer（回撤的 MutationObserver、样式注入都在这里收），
    // 再卸载；否则观察者在全局对象清掉之后还会被回调触发。
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* 清理失败不影响后续 */ }
    }
    // 不在 act 里卸载：node:test 退出阶段 act 会留下一个永不落地的微任务。
    reactRoot.unmount()
    dom.window.close()
    for (const key of ['window', 'document', 'localStorage', 'fetch', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'IntersectionObserver', 'IS_REACT_ACT_ENVIRONMENT']) {
      delete globalThis[key]
    }
  }
  return { window, container, renderMain, registrations, tick, waitFor, reportIntersection, close, picker: ctx.uiWorkspace }
}
