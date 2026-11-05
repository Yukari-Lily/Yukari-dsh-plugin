import test from 'node:test'
import assert from 'node:assert/strict'
import { BODY_LIMITS, guardRoute, readJsonBody, sendJson } from '../host/shared/http.js'

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
