/**
 * The preset store: the only file this component owns.
 *
 * `$DSH_HOME/presets.json` holds every preset the panel created, so a
 * restart re-registers them without touching the profile's own patch layer.
 * Reads never throw and never repair: a file this module cannot parse is
 * reported as an error, and every write is then refused — silently rewriting
 * a file we did not understand would delete presets we never showed the user.
 * @module yukari-dsh-plugin/presets/store
 */
import fs from 'node:fs'
import path from 'node:path'
import { clone, entryListProblem, MAX_PRESETS } from './definition.js'

/** Current file format. */
export const STORE_VERSION = 1

/** File name inside `$DSH_HOME`. */
export const STORE_FILE = 'presets.json'

/**
 * Absolute path of the store.
 * @param dshHome - resolved `$DSH_HOME`.
 */
export function storePath(dshHome) {
  return path.join(dshHome, STORE_FILE)
}

/** One entry's problem, without stopping the whole file. */
function entryProblem(entry, seen) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return '不是预设对象'
  if (typeof entry.id !== 'string' || entry.id.trim() === '') return '缺少 id'
  if (seen.has(entry.id)) return `id 重复：${entry.id}`
  if (!Array.isArray(entry.plugins)) return '缺少 plugins 列表'
  const problem = entryListProblem(entry.plugins)
  if (problem !== undefined) return problem
  return undefined
}

/**
 * Read the store.
 * @param file - absolute path; a missing file is an empty store.
 * @returns `{ path, exists, entries, error, mtimeMs }`; `error` is set when the
 * file exists but cannot be trusted, in which case the caller must not write.
 */
export function readStore(file) {
  const store = { path: file, exists: false, entries: [], error: null, mtimeMs: 0 }
  if (!file) return store
  let text
  try {
    const info = fs.statSync(file)
    if (!info.isFile()) {
      store.error = '预设存档不是普通文件'
      return store
    }
    store.exists = true
    store.mtimeMs = info.mtimeMs
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return store
    store.error = `读不了预设存档：${error?.message ?? error}`
    return store
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    store.error = `预设存档不是合法 JSON：${error.message}`
    return store
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    store.error = '预设存档的顶层必须是一个对象'
    return store
  }
  if (parsed.version !== STORE_VERSION) {
    store.error = `预设存档的版本是 ${String(parsed.version)}，这个插件只认 ${STORE_VERSION}`
    return store
  }
  if (!Array.isArray(parsed.presets)) {
    store.error = '预设存档的 presets 必须是列表'
    return store
  }
  const seen = new Set()
  for (const raw of parsed.presets) {
    if (raw === null || typeof raw !== 'object') continue
    const problem = entryProblem(raw, seen)
    if (typeof raw.id === 'string' && raw.id.trim() !== '') seen.add(raw.id)
    store.entries.push({
      id: typeof raw.id === 'string' ? raw.id : '',
      name: typeof raw.name === 'string' ? raw.name : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : undefined,
      plugins: Array.isArray(raw.plugins) ? clone(raw.plugins) : [],
      problem,
    })
  }
  return store
}

/**
 * Replace the store's entries atomically.
 *
 * The file is written to a sibling temporary path with `0600` and renamed, so a
 * crash leaves either the previous file or the new one, never half of each.
 * @param file - absolute path.
 * @param entries - full entry list (`problem` is not persisted).
 */
export function writeStore(file, entries) {
  if (!file) throw new Error('这个环境没有 DSH_HOME，无法保存预设')
  if (entries.length > MAX_PRESETS) throw new Error(`最多保存 ${MAX_PRESETS} 个预设`)
  const presets = entries.map((entry) => {
    const row = { id: entry.id, plugins: clone(entry.plugins ?? []) }
    if (entry.name) row.name = entry.name
    if (entry.description) row.description = entry.description
    if (entry.order !== undefined) row.order = entry.order
    return row
  })
  const text = `${JSON.stringify({ version: STORE_VERSION, presets }, null, 2)}\n`
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, file)
  } catch (error) {
    try {
      fs.unlinkSync(temporary)
    } catch {
      /* already gone */
    }
    throw error
  }
}
