/**
 * Where each preset comes from, and what the panel may do with it.
 *
 * The roster mixes four kinds of preset, and conflating them would make the
 * panel promise things it cannot keep:
 *
 * - `store`   — created here; this component owns the definition and can
 *               register, replace and unregister it.
 * - `declared` — a Loader row (`@deepseek-ai/dsh-agent-preset`) from a bundle or
 *               the profile patch; editable through `configEditor`, never
 *               deletable (that file is the user's own).
 * - `builtin` — a declared row the harness ships under a reserved id; read-only,
 *               but a fine template.
 * - `runtime` — registered by another plugin at runtime (`unrestricted` is the
 *               local example). Its composition is only reachable as YAML,
 *               unless the owner wrote a machine-readable definition to
 *               `$DSH_HOME/.agent-presets/<id>/preset.json`.
 * @module yukari-dsh-plugin/presets/sources
 */
import fs from 'node:fs'
import path from 'node:path'
import { BUILTIN_PRESETS, clone, normalizeRows } from './definition.js'

/** The Loader row that declares one preset. */
const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset'

/** Directory a plugin may use to keep its own preset definition readable. */
const DISK_PRESET_DIR = '.agent-presets'

/** Ids that are safe to turn into a path segment. */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Where a preset comes from, in the order the panel shows them. */
export const SOURCES = ['store', 'declared', 'builtin', 'runtime']

/**
 * Index the declaration rows the Loader currently holds.
 * @param ctx - plugin context.
 * @returns `{ available, rows, error }`; rows map a preset id to its row.
 */
export function declaredPresets(ctx) {
  const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
  if (!editor || typeof editor.entries !== 'function') {
    return { available: false, rows: new Map(), error: '当前 profile 未提供 configEditor，无法读取声明式预设' }
  }
  try {
    const rows = new Map()
    for (const entry of editor.entries()) {
      if (entry?.options?.name !== PRESET_PACKAGE) continue
      const config = entry.options.config
      if (!config || typeof config !== 'object' || Array.isArray(config)) continue
      const id = typeof config.id === 'string' ? config.id : ''
      if (id === '') continue
      rows.set(id, {
        entry,
        entryId: entry.id,
        config,
        plugins: Array.isArray(config.plugins) ? config.plugins : null,
      })
    }
    return { available: true, rows, error: null }
  } catch (error) {
    return { available: false, rows: new Map(), error: `读声明式预设失败：${error?.message ?? error}` }
  }
}

/**
 * Read a preset definition another plugin persisted for its own registration.
 *
 * The convention is deliberately small: `<DSH_HOME>/.agent-presets/<id>/preset.json`
 * holding `{ name, description, order, plugins }`. A plugin that registers a
 * preset and wants it copyable writes that file; one that does not simply keeps
 * its preset view-only.
 * @param dshHome - resolved `$DSH_HOME`.
 * @param id - preset id.
 * @returns the parsed definition, or null.
 */
export function diskPreset(dshHome, id) {
  if (!dshHome || typeof id !== 'string' || !SAFE_ID.test(id)) return null
  const file = path.join(dshHome, DISK_PRESET_DIR, id, 'preset.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (!Array.isArray(parsed.plugins)) return null
    return parsed
  } catch {
    return null
  }
}

/** Whether a declared row is a shipped preset rather than a user one. */
function isBuiltin(id, config) {
  return BUILTIN_PRESETS.includes(id) && typeof config?.name !== 'string'
}

/**
 * Resolve the structured composition behind one preset id.
 * @param ctx - plugin context.
 * @param request - `{ id, storeEntries, declared, dshHome }`.
 * @returns `{ plugins, source, notes }`.
 * @throws when the preset has no readable structure.
 */
export function resolveTemplate(ctx, request) {
  const { id, storeEntries = [], declared, dshHome } = request
  const stored = storeEntries.find((entry) => entry.id === id)
  if (stored !== undefined) {
    const { plugins, notes } = normalizeRows(stored.plugins)
    return { plugins, source: 'store', notes: notes.map(noteOf) }
  }
  const row = declared?.rows?.get(id)
  if (row !== undefined && row.plugins !== null) {
    const { plugins, notes } = normalizeRows(row.plugins)
    return { plugins, source: isBuiltin(id, row.config) ? 'builtin' : 'declared', notes: notes.map(noteOf) }
  }
  const disk = diskPreset(dshHome, id)
  if (disk !== null) {
    const { plugins, notes } = normalizeRows(disk.plugins)
    return { plugins, source: 'runtime', notes: notes.map(noteOf) }
  }
  throw new Error('这个预设由插件在运行时注册，读不到结构化组合；可以查看它的 YAML 组合。')
}

/** Panel-facing sentence for one normalization note. */
function noteOf(note) {
  if (note === 'platform') return '已按当前平台把 platform 条件固定成 disabled'
  return note
}

/**
 * Build the roster the panel renders: every preset the harness currently has,
 * tagged with its source and the actions this component can actually perform.
 * @param ctx - plugin context.
 * @param request - `{ storeEntries, dshHome }`.
 * @returns `{ items, defaultId, declaredAvailable, declaredError }`.
 */
export async function classify(ctx, request) {
  const { storeEntries = [], dshHome } = request
  const declared = declaredPresets(ctx)
  let roster = []
  let rosterError = null
  try {
    roster = await ctx.agentPresets.list()
  } catch (error) {
    rosterError = `读预设列表失败：${error?.message ?? error}`
  }
  const defaultId = typeof ctx.agentPresets.defaultId === 'string' ? ctx.agentPresets.defaultId : null

  const ids = new Set()
  for (const row of roster) if (typeof row?.id === 'string') ids.add(row.id)
  for (const entry of storeEntries) if (typeof entry.id === 'string' && entry.id !== '') ids.add(entry.id)
  for (const id of declared.rows.keys()) ids.add(id)

  const items = []
  for (const id of ids) {
    const rosterRow = roster.find((row) => row?.id === id)
    const stored = storeEntries.find((entry) => entry.id === id)
    const row = declared.rows.get(id)
    const broken = rosterRow?.broken ?? (stored?.problem ?? null)

    let source
    let plugins = null
    let canEdit = false
    let canDelete = false
    let reason = null

    if (stored !== undefined) {
      source = 'store'
      plugins = stored.plugins
      canEdit = stored.problem === undefined || stored.problem === null
      canDelete = true
      if (stored.problem) reason = stored.problem
    } else if (row !== undefined && row.plugins !== null) {
      source = isBuiltin(id, row.config) ? 'builtin' : 'declared'
      plugins = row.plugins
      canEdit = source === 'declared' && declared.available
      if (source === 'builtin') reason = '内置预设只读，可以先复制一份再改'
    } else if (row !== undefined) {
      source = isBuiltin(id, row.config) ? 'builtin' : 'declared'
      plugins = null
      reason = '这个预设的组合是一段表达式，读不到逐行结构'
    } else {
      const disk = diskPreset(dshHome, id)
      source = 'runtime'
      plugins = disk === null ? null : disk.plugins
      if (!declared.available) {
        // Without the config editor every declared row is invisible, so a missing
        // structure says nothing about the preset itself.
        reason = declared.error ?? '读不到声明式预设'
      } else {
        reason = disk === null ? '由插件在运行时注册，只能查看' : '由插件在运行时注册，可以复制但改不了原件'
      }
    }

    const canTemplate = Array.isArray(plugins)
    const name =
      stored?.name ??
      (typeof row?.config?.name === 'string' ? row.config.name : undefined) ??
      (typeof rosterRow?.name === 'string' ? rosterRow.name : undefined)
    const rawDescription =
      stored?.description ??
      (typeof row?.config?.description === 'string' ? row.config.description : undefined) ??
      (typeof rosterRow?.description === 'string' ? rosterRow.description : undefined)
    const orderCandidate =
      stored?.order ??
      (typeof row?.config?.order === 'number' ? row.config.order : undefined) ??
      (typeof rosterRow?.order === 'number' ? rosterRow.order : undefined)

    items.push({
      id,
      name,
      description: rawDescription,
      order: typeof orderCandidate === 'number' && Number.isFinite(orderCandidate) ? orderCandidate : null,
      source,
      isDefault: id === defaultId,
      broken,
      rows: Array.isArray(plugins) ? countRows(plugins) : null,
      canTemplate,
      canEdit,
      canDelete,
      reason,
      entryId: row?.entryId ?? null,
    })
  }

  items.sort((left, right) => {
    const a = left.order ?? Number.POSITIVE_INFINITY
    const b = right.order ?? Number.POSITIVE_INFINITY
    if (a !== b) return a - b
    return left.id.localeCompare(right.id)
  })

  return {
    items,
    defaultId,
    declaredAvailable: declared.available,
    declaredError: declared.error,
    rosterError,
  }
}

/** Visible row count, counting group children. */
export function countRows(rows) {
  let total = 0
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    total += 1
    if (row.group === true && Array.isArray(row.config)) total += countRows(row.config)
  }
  return total
}

/**
 * The composition a preset currently publishes, as far as it can be read.
 * @param ctx - plugin context.
 * @param request - `{ id, storeEntries, declared, dshHome }`.
 * @returns `{ plugins, yaml, source }`; `plugins` is null when unavailable.
 */
export async function readComposition(ctx, request) {
  let plugins = null
  let source = null
  let notes = []
  try {
    const resolved = resolveTemplate(ctx, request)
    plugins = resolved.plugins
    source = resolved.source
    notes = resolved.notes
  } catch {
    plugins = null
  }
  let yaml = null
  try {
    const document = await ctx.agentPresets.readDocument?.(request.id)
    if (document && typeof document.content === 'string') yaml = document.content
  } catch {
    yaml = null
  }
  return { plugins: plugins === null ? null : clone(plugins), yaml, source, notes }
}
