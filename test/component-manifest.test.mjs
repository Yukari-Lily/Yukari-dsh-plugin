/**
 * The component list is written down four times: the bundle patch, the export
 * map, the locale exports and the panel's tabs. This test makes one of them the
 * source and the rest derived, so adding or renaming a component cannot leave a
 * row that points at a missing file or a tab with no endpoint.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const manifest = JSON.parse(read('package.json'))

/** Rows the bundle patch inserts, in order: `{ id, name }`. */
function bundleRows() {
  const rows = []
  let id = null
  for (const line of read('cordis.patch.yml').split('\n')) {
    const rowId = /^\s+- id: (\S+)/.exec(line)
    if (rowId !== null) {
      id = rowId[1]
      continue
    }
    const name = /^\s+name: (\S+)/.exec(line)
    if (name !== null && id !== null) {
      rows.push({ id, name: name[1] })
      id = null
    }
  }
  return rows
}

/** `yukari-dsh-plugin/chats` -> `chats`; the main row has no suffix. */
const suffixOf = (name) => {
  const prefix = 'yukari-dsh-plugin/'
  assert.ok(name === 'yukari-dsh-plugin' || name.startsWith(prefix), `unexpected row name ${name}`)
  return name === 'yukari-dsh-plugin' ? '' : name.slice(prefix.length)
}

test('bundle: every component row points at an exported, existing entry', () => {
  const rows = bundleRows()
  assert.equal(rows.length, 13, 'main row plus twelve components')
  assert.equal(rows[0].name, 'yukari-dsh-plugin')
  const components = rows.slice(1).map((row) => suffixOf(row.name))
  assert.equal(new Set(components).size, components.length, 'component rows must be unique')
  for (const name of components) {
    const entry = manifest.exports[`./${name}`]
    assert.equal(entry, `./host/${name}/index.js`, `exports["./${name}"]`)
    assert.ok(existsSync(path.join(root, entry)), `${entry} is missing`)
    assert.ok(existsSync(path.join(root, 'host', name, 'index.js')), `host/${name}/index.js is missing`)
  }
})

test('bundle: ids keep the yukari- prefix and match their component name', () => {
  const rows = bundleRows()
  for (const row of rows) {
    assert.match(row.id, /^yukari(?:-[a-z0-9-]+)?$/, row.id)
    const name = suffixOf(row.name)
    assert.equal(row.id, name === '' ? 'yukari' : `yukari-${name}`, `row id for ${row.name}`)
  }
})

test('locales: a component with locale files also exports them', () => {
  for (const row of bundleRows().slice(1)) {
    const name = suffixOf(row.name)
    if (!existsSync(path.join(root, 'host', name, 'locale'))) continue
    assert.equal(manifest.exports[`./${name}/locale/*.json`], `./host/${name}/locale/*.json`, `${name} locale export`)
  }
})

/** Components with a panel tab. Rewind lives on the message row, not in a tab. */
const TABLESS = ['rewind']

test('panel: every tab names a component and every component has an endpoint', () => {
  const client = read('client.js')
  const tabs = /const TABS = \[([^\]]+)\]/.exec(client)
  assert.ok(tabs !== null, 'TABS array not found')
  const names = tabs[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')).filter(Boolean)
  assert.equal(names[0], 'overview')
  const components = bundleRows().slice(1).map((row) => suffixOf(row.name))
  for (const name of names.slice(1)) {
    assert.ok(components.includes(name), `tab ${name} has no component row`)
  }
  assert.deepEqual(components.filter((name) => !names.includes(name)).sort(), TABLESS.slice().sort())
  for (const name of components) {
    assert.ok(client.includes(`  ${name}: '/`), `API map is missing ${name}`)
  }
})

test('files whitelist ships every component entry', () => {
  for (const name of bundleRows().slice(1).map((row) => suffixOf(row.name))) {
    assert.ok(existsSync(path.join(root, 'host', name, 'index.js')))
  }
  assert.ok(manifest.files.includes('host/**/*.js'))
})

/** 每个 bundle 行 `config:` 块里的键，按行名归组。 */
function bundleConfigKeys() {
  const rows = []
  let current = null
  let inConfig = false
  for (const line of read('cordis.patch.yml').split('\n')) {
    const rowId = /^\s+- id: (\S+)/.exec(line)
    if (rowId !== null) {
      current = { id: rowId[1], name: null, keys: [] }
      rows.push(current)
      inConfig = false
      continue
    }
    const name = /^\s+name: (\S+)/.exec(line)
    if (name !== null && current !== null && current.name === null) {
      current.name = name[1]
      continue
    }
    if (/^\s+config:\s*$/.test(line)) {
      inConfig = true
      continue
    }
    if (inConfig === true) {
      const key = /^\s{8}([A-Za-z][A-Za-z0-9]*):/.exec(line)
      if (key !== null) current.keys.push(key[1])
      else if (/^\s{0,7}\S/.test(line)) inConfig = false
    }
  }
  return rows.filter((row) => row.name !== null && row.keys.length > 0)
}

test('config: every key a bundle row sets is read by that component', () => {
  for (const row of bundleConfigKeys()) {
    const name = suffixOf(row.name)
    const directory = path.join(root, 'host', name)
    const files = [path.join(directory, 'index.js')]
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === 'lib') {
        for (const lib of readdirSync(path.join(directory, 'lib'))) {
          if (lib.endsWith('.js')) files.push(path.join(directory, 'lib', lib))
        }
      }
    }
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
    for (const key of row.keys) {
      // 组件可能把整个 config 交给库函数（purge 的 readSettings 就是这样），
      // 所以只要求键名在实现里出现过——这仍能拦住 YAML 里拼错或改名后留下的死键。
      const pattern = new RegExp(String.raw`\b${key}\b`)
      assert.ok(pattern.test(source), `${row.name}: config.${key} is set in cordis.patch.yml but never read`)
    }
  }
})
