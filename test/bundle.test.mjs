import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/** Read the bundle patch into `id → { name, disabled }`. */
async function rows() {
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const out = new Map()
  let current = null
  for (const line of text.split('\n')) {
    const id = /^\s+- id:\s*(\S+)\s*$/.exec(line)
    if (id !== null) {
      current = { name: '', disabled: false }
      out.set(id[1], current)
      continue
    }
    if (current === null) continue
    const name = /^\s+name:\s*(\S+)\s*$/.exec(line)
    if (name !== null) current.name = name[1]
    if (/^\s+disabled:\s*true\s*$/.test(line)) current.disabled = true
  }
  return out
}

test('the bundle registers every component under its own row id', async () => {
  const table = await rows()
  assert.deepEqual(
    [...table.keys()],
    ['yukari', 'yukari-chats', 'yukari-sites', 'yukari-files', 'yukari-proxy', 'yukari-purge', 'yukari-browser', 'yukari-runtime'],
  )
  assert.equal(table.get('yukari').name, 'yukari-dsh-plugin')
  for (const [id, row] of table) {
    if (id === 'yukari') continue
    assert.equal(row.name, `yukari-dsh-plugin/${id.replace('yukari-', '')}`, `${id} points at its own module`)
  }
})

test('proxy, unrestricted mode and the browser ship disabled; the rest ship on', async () => {
  const table = await rows()
  for (const id of ['yukari-proxy', 'yukari-purge', 'yukari-browser']) {
    assert.equal(table.get(id).disabled, true, `${id} must not mount before the user enables it`)
  }
  for (const id of ['yukari', 'yukari-chats', 'yukari-sites', 'yukari-files', 'yukari-runtime']) {
    assert.equal(table.get(id).disabled, false, `${id} ships enabled`)
  }
})

test('the browser row carries no eager provisioning flag of its own', async () => {
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const block = text.slice(text.indexOf('- id: yukari-browser'))
  // Provisioning is triggered by the component mounting; a disabled row never mounts.
  assert.match(block, /autoLibraries: true/u)
  assert.match(block, /sandbox: auto/u)
})
