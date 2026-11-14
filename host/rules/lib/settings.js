/**
 * Switches owned by the strong-constraint component.
 *
 * Precedence: built-in defaults < the row's config in `cordis.patch.yml` <
 * `$DSH_HOME/rules-settings.json`. The file is written atomically so a crash
 * mid-save cannot leave half a JSON that silently disables a scope.
 * @module yukari-dsh-plugin/rules/settings
 */
import fs from 'node:fs'
import path from 'node:path'

/** Every scope is on by default; the files decide whether anything is injected. */
export const DEFAULT_SETTINGS = Object.freeze({
  global: true,
  project: true,
  tailAnchor: true,
})

const KEYS = Object.keys(DEFAULT_SETTINGS)

/** Keep only known keys with boolean values. */
export function pickSwitches(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of KEYS) if (typeof raw[key] === 'boolean') out[key] = raw[key]
  return out
}

/** Defaults < base < raw. */
export function normalizeSettings(raw, base = {}) {
  return { ...DEFAULT_SETTINGS, ...pickSwitches(base), ...pickSwitches(raw) }
}

/** Read the saved overrides; an absent or unreadable file falls back to `base`. */
export function readSettings(file, base = {}) {
  const merged = normalizeSettings(base)
  if (!file) return merged
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')), merged)
  } catch {
    return merged
  }
}

/** Merge one patch into the saved file and return the effective settings. */
export function writeSettings(file, patch, current = {}) {
  const next = { ...normalizeSettings(current), ...pickSwitches(patch) }
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, file)
  }
  return next
}
