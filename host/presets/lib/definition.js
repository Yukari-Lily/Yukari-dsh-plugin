/**
 * Preset definition shape: validation and row normalization.
 *
 * The panel writes definitions that the Host registry mounts as a plugin tree,
 * so a malformed row is not a cosmetic problem — it decides which tools a new
 * session gets. Two rules keep that honest:
 *
 * - A row is only what the Loader reads. Unknown keys are dropped after the
 *   copy, so a template's `platform` marker cannot leak into a stored preset
 *   as an inert field that silently mounts both shell tools.
 * - `{ "__jsExpr": "…" }` survives JSON unchanged; the registry evaluates it
 *   when it mounts the row, exactly as the YAML `!!js` tag would.
 * @module yukari-dsh-plugin/presets/definition
 */

/** Preset ids the harness ships; a user preset may not take one over. */
export const BUILTIN_PRESETS = ['standard', 'ptc', 'minimal', 'cordis']

/** Preset identity: what a session saves and what the panel edits. */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** How many rows one composition may hold. */
export const MAX_ROWS = 500
/** How many presets the store keeps. */
export const MAX_PRESETS = 50
/** Display-name ceiling. */
export const NAME_MAX = 80
/** Description ceiling. */
export const DESC_MAX = 500
/** Roster order ceiling. */
export const ORDER_MAX = 9999

/** Row keys the Loader reads; everything else is dropped on the way in. */
const ROW_KEYS = ['id', 'name', 'config', 'group', 'disabled', 'inject']

/** Platform markers a bundled preset file may carry. */
const PLATFORM_KEYS = ['win32', 'non-win32']

/** True for the inert representation of a YAML `!!js` scalar. */
export function isJsExpr(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.__jsExpr === 'string'
  )
}

/** Deep copy that keeps `{__jsExpr}` objects and drops functions. */
export function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

/** Whether one `disabled` node is a value the Loader accepts. */
function disabledProblem(value, label) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return undefined
  if (isJsExpr(value)) return undefined
  return `${label} 的 disabled 只能是布尔值、空值或 !!js 表达式`
}

/**
 * Validate one row list the way the registry's own `entryListProblem` does,
 * with the extra `disabled` check the registry leaves to the Loader.
 * @param rows - candidate list.
 * @param at - diagnostic prefix for a nested group.
 * @param depth - nesting depth, bounded to keep the walk finite.
 * @returns the first problem, or undefined.
 */
export function entryListProblem(rows, at = '', depth = 0) {
  if (depth > 12) return at === '' ? '组合嵌套过深' : '组合嵌套过深'
  if (!Array.isArray(rows)) {
    return at === '' ? '组合必须是一行行插件的列表' : `${at} 的 config 必须是插件列表`
  }
  for (const [index, row] of rows.entries()) {
    const label = at === '' ? `第 ${index + 1} 行` : `${at} 第 ${index + 1} 行`
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return `${label} 不是插件行（需要带 name 的对象）`
    }
    if (typeof row.name !== 'string' || row.name === '') {
      return `${label} 缺少 name（插件包名）`
    }
    if (typeof row.id === 'string' && row.id.trim() === '') return `${label} 的 id 是空字符串`
    const badDisabled = disabledProblem(row.disabled, label)
    if (badDisabled !== undefined) return badDisabled
    if (row.group === true) {
      const nested = entryListProblem(row.config, label, depth + 1)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Recursively keep only Loader keys, resolve platform markers, and copy. */
function normalizeList(rows, notes) {
  const out = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      out.push(row)
      continue
    }
    const next = {}
    for (const key of ROW_KEYS) if (row[key] !== undefined) next[key] = clone(row[key])
    if (typeof row.platform === 'string' && PLATFORM_KEYS.includes(row.platform)) {
      // A bundled preset is written once and resolved per host; a stored copy is
      // one file on one machine, so the condition becomes a concrete boolean.
      if (next.disabled === undefined || next.disabled === null) {
        next.disabled = row.platform === 'win32' ? process.platform !== 'win32' : process.platform === 'win32'
      }
      if (!notes.includes('platform')) notes.push('platform')
    }
    if (next.group === true && Array.isArray(next.config)) next.config = normalizeList(next.config, notes)
    out.push(next)
  }
  return out
}

/**
 * Copy a composition into the shape a stored preset keeps.
 * @param rows - rows read from a template or from the request body.
 * @returns `{ plugins, notes }`; `notes` reports which adaptations happened.
 */
export function normalizeRows(rows) {
  const notes = []
  if (!Array.isArray(rows)) return { plugins: [], notes }
  return { plugins: normalizeList(rows, notes), notes }
}

/** Trimmed string, or undefined for a value that carries no text. */
function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Read the display fields off a candidate definition.
 * @param raw - request body or store entry.
 * @param options.requireName - whether a stored preset needs a display name.
 * @returns `{ name, description, order }` with absent fields omitted.
 */
export function readMeta(raw, options = {}) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const name = text(value.name)
  if (options.requireName === true && name === undefined) throw new Error('预设名称不能为空')
  if (name !== undefined && name.length > NAME_MAX) throw new Error(`预设名称不能超过 ${NAME_MAX} 个字符`)
  const description = text(value.description)
  if (description !== undefined && description.length > DESC_MAX) {
    throw new Error(`预设描述不能超过 ${DESC_MAX} 个字符`)
  }
  let order
  if (value.order !== undefined && value.order !== null && value.order !== '') {
    const number = typeof value.order === 'number' ? value.order : Number(String(value.order).trim())
    if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0 || number > ORDER_MAX) {
      throw new Error(`排序必须是 0 到 ${ORDER_MAX} 之间的整数`)
    }
    order = number
  }
  return { name, description, order }
}

/**
 * Validate a preset identity.
 * @param id - candidate id.
 * @param options.existing - ids already in use (roster + store).
 */
export function readId(id, options = {}) {
  const value = typeof id === 'string' ? id.trim() : ''
  if (!ID_PATTERN.test(value)) {
    throw new Error('标识只能用小写字母、数字、- 和 _，且以字母或数字开头，最长 64 个字符')
  }
  if (BUILTIN_PRESETS.includes(value)) throw new Error(`「${value}」是内置预设的标识，换一个`)
  const existing = Array.isArray(options.existing) ? options.existing : []
  if (existing.includes(value)) throw new Error(`已经有预设叫「${value}」了`)
  return value
}

/**
 * Validate a complete definition for the store.
 * @param raw - `{ id, name, description, order, plugins }`.
 * @param options.existing - ids already in use.
 * @param options.requireName - whether a display name is required.
 * @returns the definition to register and persist.
 */
export function readDefinition(raw, options = {}) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const id = readId(value.id, { existing: options.existing })
  const { name, description, order } = readMeta(value, { requireName: options.requireName === true })
  const { plugins, notes } = normalizeRows(value.plugins)
  if (plugins.length > MAX_ROWS) throw new Error(`一个预设最多 ${MAX_ROWS} 行`)
  const problem = entryListProblem(plugins)
  if (problem !== undefined) throw new Error(problem)
  const definition = { id, plugins }
  if (name !== undefined) definition.name = name
  if (description !== undefined) definition.description = description
  if (order !== undefined) definition.order = order
  return { definition, notes }
}

/**
 * Project a stored entry back into the fields the panel edits.
 * @param entry - one store entry.
 */
export function toEditable(entry) {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    order: entry.order,
    plugins: clone(entry.plugins ?? []),
  }
}
