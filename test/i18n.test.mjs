import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/** Keys of one inline dictionary in the client bundle. */
function keys(text, name) {
  const start = text.indexOf(`    const ${name} = {`)
  assert.notEqual(start, -1, `${name} dictionary not found`)
  const end = text.indexOf('\n    }', start)
  const block = text.slice(start, end)
  const found = [...block.matchAll(/^\s{6}([A-Za-z][\w]*|'[\w-]+'):/gm)].map((match) => match[1].replaceAll("'", ''))
  return found
}

test('the two client dictionaries declare exactly the same keys', async () => {
  const text = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const zh = keys(text, 'zh')
  const en = keys(text, 'en')
  assert.ok(zh.length > 100, 'the dictionaries are not empty')
  assert.deepEqual([...new Set(zh)].length, zh.length, 'no duplicate keys in zh')
  assert.deepEqual([...new Set(en)].length, en.length, 'no duplicate keys in en')
  assert.deepEqual(zh.filter((key) => !en.includes(key)), [], 'keys missing from en')
  assert.deepEqual(en.filter((key) => !zh.includes(key)), [], 'keys missing from zh')
})

test('every delete-failure reason the host can report has an entry', async () => {
  const text = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const zh = keys(text, 'zh')
  // Admin reasons plus the one the io-error path adds; an unknown reason would
  // otherwise surface as the literal key "cReason_<reason>" in the panel.
  const reasons = ['running', 'unknown', 'io-error', 'no-artifact', 'unsafe-path']
  for (const reason of reasons) {
    assert.ok(zh.includes(`cReason_${reason}`), `missing cReason_${reason}`)
  }
})

test("every t('key') in the client bundle resolves in both dictionaries", async () => {
  const text = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const zh = new Set(keys(text, 'zh'))
  const en = new Set(keys(text, 'en'))
  const used = new Set([...text.matchAll(/\bt\('([A-Za-z][\w]*)'\)/g)].map((match) => match[1]))
  assert.ok(used.size > 100, 'the usage scan found the dictionary lookups')
  const missing = [...used].filter((key) => !zh.has(key) || !en.has(key))
  assert.deepEqual(missing, [], 'a lookup without an entry renders the raw key in the panel')
})
