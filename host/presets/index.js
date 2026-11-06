/**
 * Yukari Presets: create, edit and remove custom agent presets from the panel.
 *
 * A preset is a child plugin list the registry mounts per session, so this
 * component is deliberately just a caretaker of its own definitions:
 *
 * - presets it created are registered here and persisted to
 *   `$DSH_HOME/presets.json`;
 * - presets a bundle or the profile patch declares are edited through
 *   `configEditor` (never by writing the profile patch ourselves, and never
 *   deleted);
 * - anything another plugin registered at runtime is read-only.
 *
 * "Start from an existing preset" is the primary flow: `GET /template` resolves
 * any of the above into a plain row list, already normalized, which the panel
 * edits and hands back to `create`.
 * @module yukari-dsh-plugin/presets
 */
import path from 'node:path'
import { markMounted } from '../shared/mounted.js'
import { resolveDshHome } from '../shared/home.js'
import { legacySibling, migratePath } from '../shared/migrate.js'
import { guardRoute, messageOf, readJsonBody, sendJson } from '../shared/http.js'
import {
  BUILTIN_PRESETS,
  DESC_MAX,
  MAX_PRESETS,
  MAX_ROWS,
  NAME_MAX,
  readDefinition,
  readMeta,
} from './lib/definition.js'
import { readStore, storePath, writeStore } from './lib/store.js'
import { classify, declaredPresets, readComposition, resolveTemplate } from './lib/sources.js'

/** JSON API prefix served to the panel. */
export const API_PATH = '/presets/api'

/** Services this component needs. */
export const inject = ['agentPresets', 'webServer', 'connection']

/** A composition this large is already unreasonable; refuse it before parsing. */
const MAX_BODY = 512 * 1024

/** How often a duplicate registration is retried after a hot reload. */
const REGISTER_ATTEMPTS = 3

/** Wait before retry `n`, in milliseconds. */
const retryDelay = (attempt) => 80 * (attempt + 1)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Registry duplicate diagnostics during a hot reload. */
const isDuplicate = (error) => /duplicate|already/i.test(messageOf(error))

/** The definition the registry takes for one stored entry. */
function definitionOf(entry) {
  const definition = { id: entry.id, plugins: entry.plugins }
  if (entry.name !== undefined) definition.name = entry.name
  if (entry.description !== undefined) definition.description = entry.description
  if (entry.order !== undefined) definition.order = entry.order
  return definition
}

/** One entry as the panel edits it. */
function editable(entry) {
  return {
    id: entry.id,
    name: entry.name ?? '',
    description: entry.description ?? '',
    order: entry.order ?? null,
    plugins: entry.plugins ?? [],
  }
}

export async function apply(ctx) {
  markMounted(ctx, 'presets')

  const dshHome = resolveDshHome()
  const file = storePath(dshHome)
  // Older versions wrote `yukari-presets.json`.
  migratePath(legacySibling(file, 'yukari-presets.json'), file)

  let store = readStore(file)
  /** id → disposer returned by the registry. */
  const releases = new Map()
  /** id → why the entry could not be registered. */
  const conflicts = new Map()
  /** All writes run one at a time so two clicks cannot interleave. */
  let queue = Promise.resolve()

  function serialized(operation) {
    const run = queue.then(operation, operation)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function registerEntry(entry) {
    const definition = definitionOf(entry)
    let lastError = null
    for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt += 1) {
      try {
        const release = await ctx.agentPresets.register(definition)
        releases.set(entry.id, release)
        conflicts.delete(entry.id)
        return
      } catch (error) {
        lastError = error
        if (!isDuplicate(error)) break
        await delay(retryDelay(attempt))
      }
    }
    conflicts.set(entry.id, messageOf(lastError))
    throw lastError
  }

  async function releaseEntry(id) {
    const release = releases.get(id)
    releases.delete(id)
    if (typeof release !== 'function') return
    try {
      await release()
    } catch (error) {
      ctx.logger?.warn?.('yukari-presets: 释放预设 %s 失败: %s', id, messageOf(error))
    }
  }

  async function releaseAll() {
    for (const id of [...releases.keys()]) await releaseEntry(id)
  }

  /* ------------------------------------------------------------- roster sync */

  /**
   * Tell the shipped settings page and the preset picker that the roster moved.
   *
   * The roster is not a settings namespace, so nothing emits on its behalf: the
   * one signal those surfaces refresh on is `settings/document-updated`, which
   * they treat as "re-read `agentPresets/list`". The revision we forward is the
   * registry namespace's current one, read from `describe()` first, so a form
   * listening to the same event sees no false revision jump.
   */
  function notifyRosterChanged() {
    try {
      const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
      if (!settings || typeof settings.describe !== 'function') return
      const descriptor = settings.describe().find?.((row) => row?.ns === 'agent-preset-registry')
      if (descriptor === undefined || typeof descriptor.revision !== 'number') return
      ctx.emit?.('settings/document-updated', 'agent-preset-registry', descriptor.revision)
    } catch (error) {
      ctx.logger?.warn?.('yukari-presets: 通知 roster 变更失败: %s', messageOf(error))
    }
  }

  /* --------------------------------------------------------------- lifecycle */

  for (const entry of store.entries) {
    if (entry.problem) continue
    try {
      await registerEntry(entry)
    } catch (error) {
      ctx.logger?.warn?.('yukari-presets: 注册预设 %s 失败: %s', entry.id, messageOf(error))
    }
  }
  if (store.error) ctx.logger?.warn?.('yukari-presets: %s（已停止写入）', store.error)
  else if (store.entries.length > 0) ctx.logger?.info?.('yukari-presets: 已注册 %d 个自定义预设', store.entries.length)

  ctx.effect(() => () => releaseAll(), 'yukari-presets: registrations')

  /* ------------------------------------------------------------------- reads */

  /** Roster + store state, the one payload every panel view starts from. */
  async function state() {
    refreshStore()
    const classified = await classify(ctx, { storeEntries: store.entries, dshHome })
    return {
      ok: true,
      path: file,
      exists: store.exists,
      storeError: store.error,
      conflicts: [...conflicts.entries()].map(([id, reason]) => ({ id, reason })),
      items: classified.items.map((item) => ({
        ...item,
        broken: item.broken ?? conflicts.get(item.id) ?? null,
      })),
      defaultId: classified.defaultId,
      declaredAvailable: classified.declaredAvailable,
      declaredError: classified.declaredError,
      rosterError: classified.rosterError,
      limits: { maxPresets: MAX_PRESETS, maxRows: MAX_ROWS, nameMax: NAME_MAX, descMax: DESC_MAX },
    }
  }

  /** Resolve one preset's rows, refusing when there is no structure. */
  function templateOf(id) {
    const declared = declaredPresets(ctx)
    return resolveTemplate(ctx, { id, storeEntries: store.entries, declared, dshHome })
  }

  /** Ids the registry already publishes, for duplicate checks. */
  async function rosterIds() {
    try {
      const rows = await ctx.agentPresets.list()
      return rows.map((row) => row.id)
    } catch {
      return []
    }
  }

  /** Re-read the file: an external editor owns it as much as this panel does. */
  function refreshStore() {
    store = readStore(file)
  }

  function assertWritable() {
    if (store.error) throw new Error(`${store.error}。修好存档前不会写入，避免覆盖已有预设。`)
  }

  function findEntry(id) {
    const entry = store.entries.find((candidate) => candidate.id === id)
    if (entry === undefined) throw new Error(`没有叫「${id}」的预设存档`)
    if (entry.problem) throw new Error(`这个预设的存档有问题：${entry.problem}`)
    return entry
  }

  /* ------------------------------------------------------------------ writes */

  async function create(body) {
    refreshStore()
    assertWritable()
    if (store.entries.length >= MAX_PRESETS) throw new Error(`最多保存 ${MAX_PRESETS} 个预设，先删掉不用的`)
    const existing = [...new Set([...(await rosterIds()), ...store.entries.map((entry) => entry.id)])]
    const { definition, notes } = readDefinition(body, { existing, requireName: true })
    await registerEntry(definition)
    const entry = {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      order: definition.order,
      plugins: definition.plugins,
    }
    try {
      // Every existing entry is kept, damaged ones included: a write must never
      // drop a preset the panel merely could not register.
      writeStore(file, [...store.entries, entry])
    } catch (error) {
      await releaseEntry(definition.id)
      throw new Error(`注册成功但存档写入失败：${messageOf(error)}`)
    }
    store = readStore(file)
    notifyRosterChanged()
    return { ok: true, id: definition.id, item: editable(entry), notes }
  }

  async function update(body) {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    refreshStore()
    const stored = store.entries.find((entry) => entry.id === id)

    // A declared preset is edited through the profile's own editor, so a broken
    // store must not block it.
    if (stored === undefined) return updateDeclared(id, body)

    assertWritable()
    const entry = findEntry(id)
    const existing = [...new Set([...(await rosterIds()), ...store.entries.map((item) => item.id)])].filter(
      (value) => value !== id,
    )
    const { definition, notes } = readDefinition({ ...body, id }, { existing, requireName: true })

    // Replace registration first: a composition the Loader rejects must leave
    // both the running roster and the file exactly as they were.
    const previous = definitionOf(entry)
    await releaseEntry(id)
    try {
      await registerEntry(definition)
      writeStore(file, store.entries.map((item) => (item.id === id ? { ...definition, problem: undefined } : item)))
    } catch (error) {
      await releaseEntry(id)
      try {
        await registerEntry(previous)
      } catch (restoreError) {
        ctx.logger?.warn?.('yukari-presets: 恢复预设 %s 失败: %s', id, messageOf(restoreError))
      }
      throw error instanceof Error ? error : new Error(messageOf(error))
    }
    store = readStore(file)
    notifyRosterChanged()
    return { ok: true, id, item: editable(definition), notes }
  }

  /** Edit a declared (bundle/profile) preset through the config editor. */
  async function updateDeclared(id, body) {
    if (id === '') throw new Error('缺少预设标识')
    const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
    if (!editor || typeof editor.edit !== 'function') throw new Error('这个 profile 没有 configEditor，改不了声明式预设')
    const declared = declaredPresets(ctx)
    const row = declared.rows.get(id)
    if (row === undefined) throw new Error(`没有叫「${id}」的预设`)
    if (isBuiltinRow(id, row.config)) throw new Error('内置预设只读；先复制一份自己的预设再改。')
    const { name, description, order } = readMeta(body, { requireName: false })
    const source = Array.isArray(body.plugins) ? body.plugins : row.plugins
    if (source === null) throw new Error('这个预设的组合是一段表达式，读不到逐行结构，改不了')
    const normalized = normalizeForDeclared(source)
    await editor.edit(row.entry, (current) => {
      const next = { id: current.id, plugins: normalized }
      const nextName = name ?? (typeof current.name === 'string' ? current.name : undefined)
      if (nextName !== undefined) next.name = nextName
      const nextDescription = description ?? (typeof current.description === 'string' ? current.description : undefined)
      if (nextDescription !== undefined) next.description = nextDescription
      const nextOrder = order ?? (typeof current.order === 'number' ? current.order : undefined)
      if (nextOrder !== undefined) next.order = nextOrder
      return next
    })
    notifyRosterChanged()
    return { ok: true, id, notes: [] }
  }

  async function remove(body) {
    refreshStore()
    assertWritable()
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    // A damaged entry is still deletable: that is how a broken store gets repaired.
    const entry = store.entries.find((candidate) => candidate.id === id)
    if (entry === undefined) throw new Error(`没有叫「${id}」的预设存档`)
    if (ctx.agentPresets.defaultId === id) {
      throw new Error('它是当前默认预设；先到「设置 → 智能体预设」把默认切到别的模式，再删。')
    }
    const previous = definitionOf(entry)
    await releaseEntry(id)
    try {
      writeStore(file, store.entries.filter((item) => item.id !== id))
    } catch (error) {
      try {
        if (entry.problem === undefined) await registerEntry(previous)
      } catch (restoreError) {
        ctx.logger?.warn?.('yukari-presets: 恢复预设 %s 失败: %s', id, messageOf(restoreError))
      }
      throw new Error(`存档写入失败，预设已恢复：${messageOf(error)}`)
    }
    store = readStore(file)
    notifyRosterChanged()
    return { ok: true, id }
  }

  /* ------------------------------------------------------------------- routes */

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: guardRoute(ctx, async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')

          if (req.method === 'GET' && (action === '' || action === 'state')) {
            sendJson(res, 200, await state())
            return
          }

          if (req.method === 'GET' && action === 'template') {
            const id = url.searchParams.get('id') ?? ''
            const resolved = await serialized(async () => templateOf(id))
            sendJson(res, 200, { ok: true, id, ...resolved })
            return
          }

          if (req.method === 'GET' && action === 'get') {
            const id = url.searchParams.get('id') ?? ''
            const declared = declaredPresets(ctx)
            const composition = await readComposition(ctx, { id, storeEntries: store.entries, declared, dshHome })
            const classified = await state()
            const item = classified.items.find((candidate) => candidate.id === id) ?? null
            sendJson(res, 200, { ok: true, id, item, ...composition })
            return
          }

          if (req.method === 'POST') {
            const body = await readJsonBody(req, MAX_BODY)
            if (action === 'create') {
              sendJson(res, 200, await serialized(() => create(body)))
              return
            }
            if (action === 'update') {
              sendJson(res, 200, await serialized(() => update(body)))
              return
            }
            if (action === 'delete') {
              sendJson(res, 200, await serialized(() => remove(body)))
              return
            }
          }

          sendJson(res, 404, { ok: false, error: `未知的操作：${req.method} ${action === '' ? '/' : action}` })
        }),
      }),
    'yukari-presets: routes',
  )

  ctx.logger?.info?.('yukari-presets: %s', path.join(API_PATH, 'state'))
}

/** Whether a declared row is one of the shipped presets. */
function isBuiltinRow(id, config) {
  return BUILTIN_PRESETS.includes(id) && typeof config?.name !== 'string'
}

/**
 * Normalize rows for a declared preset: same rules as a stored one, without the
 * store's identity checks.
 * @param rows - candidate rows.
 */
function normalizeForDeclared(rows) {
  return readDefinition({ id: 'declared', plugins: rows }, { existing: [] }).definition.plugins
}

/** Body ceiling the panel sends; exported for the tests. */
export const BODY_LIMIT = MAX_BODY
