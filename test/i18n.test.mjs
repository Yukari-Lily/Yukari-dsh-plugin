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
  const reasons = ['live', 'unknown', 'io-error', 'no-artifact', 'in-memory', 'unsafe-path']
  for (const reason of reasons) {
    assert.ok(zh.includes(`cReason_${reason}`), `missing cReason_${reason}`)
  }
})
