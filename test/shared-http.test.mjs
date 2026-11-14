import test from 'node:test'
import assert from 'node:assert/strict'
import { BODY_LIMITS, appError, guardRoute, readJsonBody, sendJson } from '../host/shared/http.js'

/** A request body made of the given JSON text. */
function body(text) {
  return {
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text)
    },
  }
}

function recorder() {
  return {
    statusCode: 200,
    headers: {},
    ended: false,
    payload: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(chunk = '') { this.ended = true; this.payload += chunk },
    destroy() { this.ended = true },
    get json() { return JSON.parse(this.payload) },
  }
}

test('the body reader bounds size and rejects malformed JSON', async () => {
  assert.deepEqual(await readJsonBody(body('')), {})
  assert.deepEqual(await readJsonBody(body('{"a":1}')), { a: 1 })
  assert.deepEqual(await readJsonBody(body('[]')), {})
  await assert.rejects(readJsonBody(body('{oops')), /not valid JSON/u)
  await assert.rejects(readJsonBody(body('{"a":"' + 'x'.repeat(BODY_LIMITS.small) + '"}'), BODY_LIMITS.small), /too large/u)
})

test('json responses carry the content type and no-store cache header', () => {
  const res = recorder()
  sendJson(res, 418, { ok: false, error: 'nope' })
  assert.equal(res.statusCode, 418)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.deepEqual(res.json, { ok: false, error: 'nope' })
})

test('the guard rejects unauthorised connections before the handler runs', async () => {
  let called = 0
  const route = guardRoute({ connection: { requestRejection: () => 401 } }, async () => { called += 1 })
  const res = recorder()
  await route({}, res)
  assert.equal(called, 0, 'the handler never runs')
  assert.equal(res.statusCode, 401)
  assert.equal(res.payload, '')
})

test('the guard turns a thrown failure into the shared error shape', async () => {
  const route = guardRoute(
    { connection: { requestRejection: () => undefined } },
    async () => { throw new Error('kaboom') },
  )
  const res = recorder()
  await route({}, res)
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json, { ok: false, error: 'kaboom' })
})

test('the error boundary keeps client mistakes at 400 and host failures at 500', async () => {
  const ctx = { connection: { requestRejection: () => undefined } }
  const run = async (error) => {
    const res = recorder()
    await guardRoute(ctx, async () => { throw error })({ url: '/x', method: 'GET' }, res)
    return res
  }

  const plain = await run(new Error('未知工作区'))
  assert.equal(plain.statusCode, 400)

  const coded = await run(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
  assert.equal(coded.statusCode, 500)

  const explicit = await run(Object.assign(new Error('not found'), { status: 404 }))
  assert.equal(explicit.statusCode, 404)
})

test('the error envelope carries a stable code and its parameters', async () => {
  const ctx = { connection: { requestRejection: () => undefined } }
  const run = async (error) => {
    const res = recorder()
    await guardRoute(ctx, async () => { throw error })({ url: '/x', method: 'GET' }, res)
    return res
  }
  const coded = await run(Object.assign(new Error('仍有 2 个会话使用该预设'), {
    appCode: 'preset-in-use',
    params: { count: 2 },
  }))
  assert.equal(coded.statusCode, 400, 'an appCode alone stays a client error')
  assert.deepEqual(coded.json, { ok: false, error: '仍有 2 个会话使用该预设', code: 'preset-in-use', params: { count: 2 } })

  const errno = await run(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
  assert.equal(errno.statusCode, 500)
  assert.equal(errno.json.code, undefined, 'Node errno codes are not copied into the envelope')
})

test('appError: the message stays authoritative while code and params ride along', () => {
  const plain = appError('本地端口需在 1024 到 65535 之间', 'proxy-port-invalid')
  assert.equal(plain.message, '本地端口需在 1024 到 65535 之间')
  assert.equal(plain.appCode, 'proxy-port-invalid')
  assert.equal(plain.params, undefined)
  assert.equal(plain.status, undefined)

  const detailed = appError('busy', 'busy', { n: 1 }, 409)
  assert.equal(detailed.status, 409)
  assert.deepEqual(detailed.params, { n: 1 })
})
