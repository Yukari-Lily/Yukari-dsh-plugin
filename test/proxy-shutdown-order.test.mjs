/**
 * 自动关闭路由时的落盘顺序。
 *
 * 面板与状态文件是两层：内存里的 `enabled` 翻转之后，只要进程在写盘前死掉，甚至只是
 * 还没写完，磁盘上就还是 `enabled: true`，重启会把这条已经失效的路由复活。正常机器上
 * 这段窗口只有几十微秒，CI 上偶尔才踩中；这里把 `node:fs/promises` 的写入拖慢 50ms，
 * 把窗口拉成确定可见的间隔。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { register } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

// 只拦住控制器的动态导入：本文件的静态导入在此之前已经解析完，仍用真的 fs。
const resolveHook = `
export async function resolve(specifier, context, next) {
  if (specifier === 'node:fs/promises' && !String(context.parentURL ?? '').startsWith('data:')) {
    const source = \`
import * as real from 'node:fs/promises'
export * from 'node:fs/promises'
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
export const writeFile = async (...args) => { await settle(); return real.writeFile(...args) }
export const rename = async (...args) => { await settle(); return real.rename(...args) }
\`
    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true }
  }
  return next(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(resolveHook)}`)

// 控制器经 egress.js 引用 undici；没装依赖时用一个桩顶替。
try {
  import.meta.resolve('undici')
} catch {
  const stub = 'export class Agent {} export class Pool {} export class ProxyAgent {} export const getGlobalDispatcher = () => null; export const setGlobalDispatcher = () => {}'
  const hooks = `export async function resolve(specifier, context, next) {
    if (specifier === 'undici') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)}, shortCircuit: true }
    return next(specifier, context)
  }`
  register(`data:text/javascript,${encodeURIComponent(hooks)}`)
}
const { ProxyController } = await import('../host/proxy/lib/controller.js')

const SIP002 = `ss://${Buffer.from('aes-256-gcm:pass/one+', 'utf8').toString('base64url')}@1.2.3.4:8388#HK%2001`

const healthyProbe = async () => ({ ok: true, status: 204, ms: 1, at: new Date().toISOString() })

/** Poll until `check()` is true, or fail the test after `timeoutMs`. */
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('condition did not become true in time')
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('controller: 内存报告关闭时，状态文件已经关闭', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ss-proxy-order-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'ss-proxy.json')
  const localPort = await unusedPort()
  const controller = new ProxyController({ config: { stateFile, localPort }, probeThrough: healthyProbe })
  t.after(() => controller.dispose())
  const { state } = await controller.importNodes(SIP002)
  // 节点在 enable 时的探测里是通的，之后每条隧道都拒绝：单次启动检查抓不到这种情况。
  await controller.configure({ id: state.nodes[0].id, server: '127.0.0.1', port: 1 })
  await controller.enable()
  const client = net.connect({ host: '127.0.0.1', port: localPort })
  t.after(() => client.destroy())
  await new Promise((resolve, reject) => client.once('connect', resolve).once('error', reject))
  client.end('CONNECT invalid.example:443 HTTP/1.1\r\nHost: invalid.example:443\r\n\r\n')
  await waitFor(() => controller.state().enabled === false)
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).enabled, false, '内存报告关闭时磁盘必须已经关闭')
})
