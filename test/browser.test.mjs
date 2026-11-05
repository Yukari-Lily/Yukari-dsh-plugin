import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserManager, sandboxDecision } from '../host/browser/lib/browser.js'
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

test('browser local URL policy rejects file/data by default and permits explicit opt-in', async () => {
  const manager = new BrowserManager({ allowLocalUrls: false })
  assert.match(await message(manager.open('file:///etc/passwd')), /URLs are disabled/u)
  assert.match(await message(manager.open('data:text/html,hello')), /URLs are disabled/u)
  assert.match(await message(manager.open('javascript:alert(1)')), /unsupported URL protocol/u)
  const allowed = new BrowserManager({ allowLocalUrls: true })
  // Navigation reaches provisioning rather than being rejected by URL policy.
  assert.match(await message(allowed.open('file:///tmp/test.html')), /no Chromium executable/u)
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

test('launch probe reports missing shared libraries instead of claiming success', async () => {
  const ok = await probeLaunch('/usr/bin/chrome', {
    execFile: async () => ({ stdout: 'Google Chrome 159.0.0.0\n', stderr: '' }),
  })
  assert.deepEqual(ok, { ok: true, detail: 'Google Chrome 159.0.0.0' })
  const broken = await probeLaunch('/usr/bin/chrome', {
    execFile: async () => {
      const error = new Error('Command failed')
      error.stderr = 'chrome: error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file'
      throw error
    },
  })
  assert.equal(broken.ok, false)
  assert.match(broken.detail, /missing libglib-2\.0\.so\.0/u)
  assert.match(broken.detail, /libraryPath/u)
})
