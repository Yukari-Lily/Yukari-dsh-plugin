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
    [
      'yukari',
      'yukari-chats',
      'yukari-sites',
      'yukari-rewind',
      'yukari-files',
      'yukari-rules',
      'yukari-skills',
      'yukari-proxy',
      'yukari-presets',
      'yukari-github',
      'yukari-purge',
      'yukari-browser',
      'yukari-runtime',
    ],
  )
  assert.equal(table.get('yukari').name, 'yukari-dsh-plugin')
  for (const [id, row] of table) {
    if (id === 'yukari') continue
    assert.equal(row.name, `yukari-dsh-plugin/${id.replace('yukari-', '')}`, `${id} points at its own module`)
  }
})

test('every component ships enabled, the proxy page included', async () => {
  const table = await rows()
  for (const id of table.keys()) {
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

test('the web client declares every module it requires at runtime', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const inject = pkg.dsh?.client?.inject ?? []
  const text = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const required = [...text.matchAll(/require\('(@deepseek-ai\/[^']+)'\)/g)].map((match) => match[1])
  assert.ok(required.includes('@deepseek-ai/dsh-client-ui-primitives'), 'the panel uses the host primitives')
  // 平台模块由宿主 shell 的静态模块表提供，它们不是 loader 行：写进 inject 不会生效，
  // 宿主只按 bundle 解析 inject。inject 里只放需要排在它前面的 client bundle。
  const platform = new Set(['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'])
  for (const name of required) {
    if (platform.has(name)) continue
    assert.ok(inject.includes(name), `${name} is required but not injected`)
  }
  for (const name of inject) {
    assert.equal(platform.has(name), false, `${name} is a platform module, not a client bundle`)
  }
})

test('every component row resolves to a package export', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const name of ['chats', 'sites', 'files', 'rules', 'presets', 'proxy', 'github', 'purge', 'browser', 'runtime']) {
    assert.equal(typeof pkg.exports[`./${name}`], 'string', `./${name} must be exported`)
    assert.match(pkg.exports[`./${name}`], new RegExp(`/host/${name}/index\\.js$`), `./${name} points at its module`)
  }
})

/** Panel tab name each component shows, mirroring the client dictionary. */
const TAB_NAMES = {
  chats: '会话',
  sites: '站点',
  files: '文件',
  rules: '约束',
  presets: '预设',
  proxy: '代理',
  github: 'GitHub',
  purge: '无限制模式',
  browser: '无头浏览器',
  runtime: '状态',
}

test('each component exposes locale metadata and its exports resolve', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const check = async (specifier, expected) => {
    for (const language of ['en', 'zh']) {
      assert.equal(typeof pkg.exports[`.${specifier}/locale/*.json`], 'string', `${specifier} exports its locale files`)
      const url = import.meta.resolve(`yukari-dsh-plugin${specifier}/locale/${language}.json`)
      const parsed = JSON.parse(await readFile(new URL(url), 'utf8'))
      assert.equal(typeof parsed.meta?.title, 'string', `${specifier}/${language}.json carries meta.title`)
      assert.ok(parsed.meta.title.trim().length > 0, `${specifier}/${language}.json has a non-empty title`)
    }
    const zh = JSON.parse(await readFile(new URL(import.meta.resolve(`yukari-dsh-plugin${specifier}/locale/zh.json`)), 'utf8'))
    assert.equal(zh.meta.title, expected, `${specifier} shows its panel tab name in the plugin list`)
  }
  for (const [name, expected] of Object.entries(TAB_NAMES)) await check(`/${name}`, expected)
  // The package root row names the panel itself.
  const root = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  assert.equal(root.meta.title, 'Yukari插件合集')
  assert.equal(typeof pkg.exports['./locale/*.json'], 'string', 'the package root exports its locale files')
})

test('every component module loads and exports apply with its services', async () => {
  const table = await rows()
  for (const [id] of table) {
    if (id === 'yukari') continue
    const name = id.replace('yukari-', '')
    const module = await import(new URL(`../host/${name}/index.js`, import.meta.url))
    assert.equal(typeof module.apply, 'function', `${id} exports apply`)
    assert.ok(Array.isArray(module.inject), `${id} declares the services it needs`)
  }
})
