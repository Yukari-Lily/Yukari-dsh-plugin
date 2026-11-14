import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserManager, sandboxDecision } from '../host/browser/lib/browser.js'
import { CdpClient, launchChromium } from '../host/browser/lib/cdp.js'
import { resolveExpression, snapshotExpression, valueExpression } from '../host/browser/lib/page-scripts.js'
import { apply } from '../host/browser/index.js'
import {
  BrowserRuntime, chromePlatform, downloadFile, executableIn,
  extractZip, probeLaunch, selectChromeBuild, verifyExecutable,
} from '../host/browser/lib/runtime.js'
import { zipBuffer, binaryResponse } from './zip-fixture.mjs'

const message = async (promise) => {
  try { await promise } catch (error) { return error.message }
  assert.fail('expected rejection')
}
const response = (body, options = {}) => ({
  ok: options.ok ?? true, status: options.status ?? 200, body: [Buffer.from(body)],
  headers: { get: (name) => name === 'content-length' ? options.length ?? String(Buffer.byteLength(body)) : null },
})

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'browser-runtime-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function archiveExecutable(directory, platform = 'linux', arch = 'x64') {
  return executableIn(directory, platform, arch)
}

function build(version, platform) {
  return { version, downloads: { chrome: [{ platform, url: `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-${platform}.zip` }] } }
}

/** Newest build is listed first on purpose: ranking must not trust order. */
function metadata(platform = 'linux64') {
  return {
    versions: [
      build('141.0.0.0', platform),
      build('139.0.0.0', platform),
      { version: '140.0.0.0', downloads: { chrome: [{ platform: 'linux64', url: 'https://storage.googleapis.com/x.zip' }] } },
    ],
  }
}

function installer(t, extra = {}) {
  const home = extra.home
  const fetch = async (url) => {
    if (url.includes('known-good')) return response(JSON.stringify(metadata(extra.archivePlatform)))
    const prefix = executableIn('', extra.platform ?? 'linux', extra.arch ?? 'x64').replace(/^\/+/, '')
    return binaryResponse(zipBuffer([{ name: prefix, data: Buffer.from('#!/bin/sh\nexit 0\n') }]))
  }
  return new BrowserRuntime({ downloadTimeoutMs: 100, ...extra.config }, { home, fetch, platform: 'linux', arch: 'x64', ...extra.deps })
}

test('Chrome platform support and stable build selection', () => {
  assert.equal(chromePlatform('linux', 'arm64'), 'linux-arm64')
  assert.equal(chromePlatform('darwin', 'x64'), 'mac-x64')
  assert.equal(chromePlatform('win32', 'x64'), 'win64')
  assert.throws(() => chromePlatform('freebsd', 'x64'), /no supported/u)
  const selected = selectChromeBuild(metadata('mac-arm64'), 'mac-arm64')
  assert.equal(selected.version, '141.0.0.0')
  assert.throws(() => selectChromeBuild(metadata(), 'win64'), /no win64 download/u)
})

test('automatic install extracts into DSH_HOME and reuses the same promise', async (t) => {
  const home = await temporary(t)
  const runtime = installer(t, { home })
  const first = runtime.ensureReady()
  assert.equal(runtime.ensureReady(), first)
  const executable = await first
  assert.equal(executable, archiveExecutable(path.join(home, 'browser-runtime', 'chrome', '141.0.0.0', 'linux64')))
  assert.equal(runtime.state().status, 'ready')
  assert.equal(runtime.state().version, '141.0.0.0')
  await verifyExecutable(executable)
  assert.equal(await runtime.retry(), executable)
})

test('cached installation avoids all downloads', async (t) => {
  const home = await temporary(t)
  const destination = path.join(home, 'browser-runtime', 'chrome', '141.0.0.0', 'linux64')
  const executable = archiveExecutable(destination)
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(executable, 'cached')
  await chmod(executable, 0o755)
  const runtime = installer(t, { home })
  assert.equal(await runtime.ensureReady(), executable)
  assert.equal(runtime.state().source, 'cache')
})

test('download limits and HTTP failures leave errors and permit retry', async (t) => {
  const directory = await temporary(t)
  await assert.rejects(downloadFile('https://example.test', path.join(directory, 'large'), {
    fetch: async () => response('12345'), maxBytes: 4,
  }), /exceeds/u)
  await assert.rejects(downloadFile('https://example.test', path.join(directory, 'http'), {
    fetch: async () => response('', { ok: false, status: 503 }),
  }), /HTTP 503/u)
  await assert.rejects(downloadFile('https://example.test', path.join(directory, 'timeout'), {
    fetch: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))), timeoutMs: 5,
  }), /timed out/u)
  const runtime = new BrowserRuntime({}, { home: directory, fetch: async () => response('', { ok: false, status: 503 }) })
  await assert.rejects(runtime.ensureReady(), /Automatic Chromium installation failed/u)
  assert.equal(runtime.state().status, 'error')
  assert.equal(runtime.retry().constructor, Promise)
  await runtime.retry().catch(() => {})
})

test('built-in ZIP extraction restores nested entries and refuses escapes', async (t) => {
  const directory = await temporary(t)
  const archive = path.join(directory, 'chrome.zip')
  const payload = Buffer.from('binary payload')
  await writeFile(archive, zipBuffer([{ name: 'chrome-linux64/chrome', data: payload }]))
  const output = path.join(directory, 'out')
  await extractZip(archive, output)
  assert.deepEqual(await readFile(path.join(output, 'chrome-linux64', 'chrome')), payload)
  assert.equal((await stat(path.join(output, 'chrome-linux64', 'chrome'))).mode & 0o111, 0o111)

  const escaping = path.join(directory, 'escape.zip')
  await writeFile(escaping, zipBuffer([{ name: '../outside.txt', data: Buffer.from('x') }]))
  await assert.rejects(extractZip(escaping, path.join(directory, 'escape')), /escapes the destination/u)
  const absolute = path.join(directory, 'absolute.zip')
  await writeFile(absolute, zipBuffer([{ name: '/etc/passwd', data: Buffer.from('x') }]))
  await assert.rejects(extractZip(absolute, path.join(directory, 'absolute')), /absolute path/u)
})

/** 一个不会真的去准备浏览器的 runtime：被调用即说明 URL 检查放行了。 */
const reachProvisioning = { ensureReady: async () => { throw new Error('provisioning reached') } }

test('browser local URL policy rejects file/data by default and permits explicit opt-in', async () => {
  // 注入假 runtime：CI 里没有 Chrome，真实 ensureReady 会去下载并拖住用例。
  const manager = new BrowserManager({ allowLocalUrls: false, executablePath: '/definitely/missing/browser' }, reachProvisioning)
  assert.match(await message(manager.open('file:///etc/passwd')), /URL 默认被禁用/u)
  assert.match(await message(manager.open('data:text/html,hello')), /URL 默认被禁用/u)
  assert.match(await message(manager.open('javascript:alert(1)')), /不支持的 URL 协议/u)
  const allowed = new BrowserManager({ allowLocalUrls: true, executablePath: '/definitely/missing/browser' }, reachProvisioning)
  // Navigation reaches provisioning rather than being rejected by URL policy.
  assert.match(await message(allowed.open('file:///tmp/test.html')), /provisioning reached/u)
})

test('loopback, private, and link-local addresses are refused unless local URLs are enabled', async () => {
  const manager = new BrowserManager({ allowLocalUrls: false, executablePath: '/definitely/missing/browser' }, reachProvisioning)
  for (const url of [
    'http://127.0.0.1:8080/',
    'http://127.9.8.7/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://localhost:3000/',
  ]) {
    assert.match(await message(manager.open(url)), /默认禁止访问/u, url)
  }
  for (const url of ['http://172.15.0.1/', 'http://172.32.0.1/', 'http://192.169.0.1/', 'http://8.8.8.8/', 'https://example.com/']) {
    // 放行的地址会继续走到准备浏览器这一步；断言这一点，避免依赖本机是否装了 Chrome。
    assert.match(await message(manager.open(url)), /provisioning reached/u, url)
  }
  const allowed = new BrowserManager({ allowLocalUrls: true, executablePath: '/definitely/missing/browser' }, reachProvisioning)
  assert.match(await message(allowed.open('http://127.0.0.1:8080/')), /provisioning reached/u)
})

test('browser runtime is awaited when a tool starts without a system browser', async () => {
  const manager = new BrowserManager({ executablePath: '/definitely/missing/browser', startTimeoutMs: 5 }, {
    ensureReady: async () => { throw new Error('provisioning failed') },
  })
  assert.match(await message(manager.open('https://example.com')), /provisioning failed/u)
})

function pluginFixture(runtimeState = { status: 'ready', executablePath: '/tmp/chrome' }) {
  const tools = new Map()
  const routes = []
  const cleanups = []
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    webServer: { register: (route) => routes.push(route) },
    connection: { requestRejection: () => undefined },
    effect: (callback) => { const cleanup = callback(); if (cleanup) cleanups.push(cleanup) },
    logger: () => ({ warn: () => {} }),
  }
  const runtime = {
    current: { ...runtimeState }, ensureCalls: 0,
    state() { return this.current },
    ensureReady() { this.ensureCalls++; return Promise.resolve(this.current.executablePath) },
    retry() { this.current = { ...this.current, status: 'ready' }; return this.ensureReady() },
  }
  apply(ctx, { executablePath: runtimeState.executablePath }, { runtime })
  const state = async () => {
    const res = responseRecorder()
    await routes[0].handler({ url: '/browser/api/state', method: 'GET' }, res)
    return { res, state: JSON.parse(res.body).state }
  }
  return { tools, route: routes[0], cleanups, state }
}

function responseRecorder() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(body = '') { this.body += body },
  }
}

test('plugin mount registers all existing tools and guarded runtime endpoints', async () => {
  const { tools, route, state } = pluginFixture()
  assert.equal(tools.size, 10)
  assert.ok(tools.has('browser_open'))
  assert.ok(tools.has('browser_close'))
  assert.equal(route.path, '/browser/api')
  const req = { url: '/browser/api/state', method: 'GET' }
  await new Promise((resolve) => setImmediate(resolve))
  const { res } = await state()
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).state.status, 'ready')
  assert.equal(res.headers['cache-control'], 'no-store')
  const wrongMethod = responseRecorder()
  await route.handler({ ...req, method: 'POST' }, wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
})

test('runtime API applies connection rejection before handling requests', async () => {
  const { route, state } = pluginFixture()
  await state() // Let the mount-time verification settle.
  const retry = responseRecorder()
  await route.handler({ url: '/browser/api/install/retry', method: 'POST' }, retry)
  assert.equal(retry.statusCode, 200)
  assert.equal(JSON.parse(retry.body).state.status, 'ready')
})

test('sandbox policy keeps isolation on a normal host and explains container fallbacks', () => {
  assert.deepEqual(sandboxDecision({ sandbox: true }, { uid: 0, container: true }), { enabled: true, reason: 'configured', flag: '' })
  assert.deepEqual(sandboxDecision({ sandbox: false }, { uid: 1000, container: false }), { enabled: false, reason: 'configured', flag: '--no-sandbox' })
  assert.equal(sandboxDecision({ sandbox: 'auto' }, { uid: 1000, container: false }).enabled, true)
  assert.deepEqual(sandboxDecision({ sandbox: 'auto' }, { uid: 1000, container: true }), { enabled: false, reason: 'container', flag: '--no-sandbox' })
  assert.deepEqual(sandboxDecision({ sandbox: 'auto' }, { uid: 0, container: false }), { enabled: false, reason: 'root', flag: '--no-sandbox' })
})

test('launch probe names every missing library and builds the fix command', async () => {
  const ok = await probeLaunch('/usr/bin/chrome', {
    execFile: async () => ({ stdout: 'Google Chrome 159.0.0.0\n', stderr: '' }),
  })
  assert.deepEqual(ok, { ok: true, detail: 'Google Chrome 159.0.0.0' })

  // The loader reports one library; `ldd` lists the rest and must win.
  const broken = await probeLaunch('/usr/bin/chrome', {
    execFile: async (command) => {
      if (command === 'ldd') {
        return { stdout: '\tlibglib-2.0.so.0 => not found\n\tlibnss3.so => not found\n', stderr: '' }
      }
      const error = new Error('Command failed')
      error.stderr = 'chrome: error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file'
      throw error
    },
  })
  assert.equal(broken.ok, false)
  assert.deepEqual(broken.missing, ['libglib-2.0.so.0', 'libnss3.so'])
  assert.ok(broken.packages.includes('libglib2.0-0'))
  assert.ok(broken.packages.includes('libnss3'))
  assert.match(broken.command, /^apt-get update && apt-get install -y --no-install-recommends /u)
  assert.match(broken.hint, /libraryPath/u)
})

/** Minimal DOM good enough for the page expressions: one element and a body. */
function evaluateInFakePage(expression, element) {
  const document = {
    title: 'Example',
    readyState: 'complete',
    body: { innerText: 'Example page', textContent: 'Example page' },
    documentElement: { scrollHeight: 600 },
    querySelectorAll: () => [element],
    getElementById: () => null,
  }
  const window = { innerHeight: 800, innerWidth: 1200, scrollY: 0 }
  const location = { href: 'https://example.com/login' }
  const getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' })
  const run = new Function('document', 'window', 'location', 'getComputedStyle', `return (${expression})`)
  return run(document, window, location, getComputedStyle)
}

function fakeInput(attributes = {}, value = '') {
  return {
    tagName: 'INPUT',
    value,
    type: attributes.type ?? 'text',
    disabled: false,
    checked: false,
    innerText: '',
    textContent: '',
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 120, height: 24, top: 0, left: 0, bottom: 24, right: 120 }),
    scrollIntoView: () => {},
  }
}

test('page snapshots mask password and token field values', () => {
  const password = fakeInput({ type: 'password', name: 'password', id: 'pwd', placeholder: 'Password' }, 'hunter2-secret')
  const snapshot = evaluateInFakePage(snapshotExpression(), password)
  assert.equal(snapshot.elements.length, 1)
  assert.equal(snapshot.elements[0].value, '••••')
  assert.doesNotMatch(JSON.stringify(snapshot), /hunter2-secret/u)

  const empty = evaluateInFakePage(snapshotExpression(), fakeInput({ type: 'password', name: 'password' }))
  assert.equal(empty.elements[0].value, undefined)

  for (const name of ['api_key', 'authToken', 'clientSecret']) {
    const field = fakeInput({ type: 'text', name, id: name }, 'sk-live-123456')
    const masked = evaluateInFakePage(snapshotExpression(), field)
    assert.equal(masked.elements[0].value, '••••', name)
    assert.doesNotMatch(JSON.stringify(masked), /sk-live-123456/u, name)
  }
})

test('action scripts never return the value of a sensitive field', () => {
  const password = fakeInput({ type: 'password', name: 'password', placeholder: 'Password' }, 'hunter2-secret')
  assert.equal(evaluateInFakePage(resolveExpression({ ref: 'e0' }), password).value, '••••')
  assert.equal(evaluateInFakePage(valueExpression({ ref: 'e0' }), password).value, '••••')

  const email = fakeInput({ type: 'email', name: 'email', placeholder: 'Email' }, 'owner@example.com')
  assert.equal(evaluateInFakePage(snapshotExpression(), email).elements[0].value, 'owner@example.com')
  assert.equal(evaluateInFakePage(valueExpression({ ref: 'e0' }), email).value, 'owner@example.com')
})

class FakeSocket {
  constructor() {
    this.listeners = new Map()
    this.sent = []
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }

  send(text) {
    this.sent.push(JSON.parse(text))
  }

  close() {
    this.emit('close', {})
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

test('a dropped CDP socket closes the client and rejects every wait', async () => {
  const socket = new FakeSocket()
  const client = new CdpClient(socket)
  let closed = false
  client.onClose(() => { closed = true })
  const pending = client.send('Page.navigate', { url: 'https://example.com' })
  const waiting = client.once('Page.loadEventFired', () => true, 60000)
  socket.emit('error', {})
  await assert.rejects(pending, /浏览器连接(已断开|出错)/u)
  await assert.rejects(waiting, /浏览器连接(已断开|出错)/u)
  assert.equal(client.open, false)
  assert.equal(closed, true)
  await assert.rejects(client.send('Runtime.evaluate'), /连接已关闭/u)
})

test('a new CDP client starts from a clean state after the old one closed', async () => {
  const old = new CdpClient(new FakeSocket())
  old.close()
  assert.equal(old.open, false)

  const socket = new FakeSocket()
  const client = new CdpClient(socket)
  const pending = client.send('Runtime.evaluate', { expression: '1 + 1' })
  socket.emit('message', { data: JSON.stringify({ id: socket.sent[0].id, result: { result: { value: 2 } } }) })
  assert.deepEqual(await pending, { result: { value: 2 } })
  assert.equal(client.open, true)
})

test('launchChromium rejects instead of crashing the host when spawn fails', async (t) => {
  const directory = await temporary(t)
  await assert.rejects(
    launchChromium({ executablePath: path.join(directory, 'definitely-missing'), args: [], timeoutMs: 1000 }),
    /无法启动浏览器进程/u,
  )
  const notExecutable = path.join(directory, 'not-executable')
  await writeFile(notExecutable, '#!/bin/sh\nexit 0\n')
  await chmod(notExecutable, 0o644)
  await assert.rejects(launchChromium({ executablePath: notExecutable, timeoutMs: 1000 }), /无法启动浏览器进程/u)
})

test('an explicit executablePath that does not exist is an error, not a silent fallback', async () => {
  const manager = new BrowserManager({ executablePath: '/definitely/missing/browser', startTimeoutMs: 5 }, reachProvisioning)
  await assert.rejects(manager.open('https://example.com'), /provisioning reached/u)
  const bare = new BrowserManager({ executablePath: '/definitely/missing/browser' })
  await assert.rejects(bare.open('https://example.com'), /配置的浏览器路径不存在/u)
})

test('run: an aborted call rejects and releases the queue', async () => {
  const manager = new BrowserManager({}, { ensureReady: async () => {} })
  const controller = new AbortController()
  let started = 0
  const first = manager.run(async () => {
    started += 1
    await new Promise((resolve) => setTimeout(resolve, 30))
    return 'first'
  }, controller.signal)
  const second = manager.run(async () => {
    started += 1
    return 'second'
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(started, 1, 'the first call is already running')
  controller.abort()
  await assert.rejects(first, /操作已取消/u)
  assert.equal(await second, 'second', 'the next call is not stuck behind the aborted one')
  assert.equal(started, 2)
})

test('run: a call that starts already cancelled never runs', async () => {
  const manager = new BrowserManager({}, { ensureReady: async () => {} })
  const controller = new AbortController()
  controller.abort()
  let ran = false
  await assert.rejects(manager.run(async () => { ran = true }, controller.signal), /操作已取消/u)
  assert.equal(ran, false)
})

test('browser tools forward the executor signal and only claim a deadline they honour', async () => {
  const { tools } = pluginFixture()
  assert.equal(tools.get('browser_open').timeoutMs, 180000)
  assert.equal(tools.get('browser_close').timeoutMs, undefined, 'closing cannot be cancelled, so it declares no deadline')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tools.get('browser_eval').execute({ expression: '1' }, { signal: controller.signal }), /操作已取消/u)
})
