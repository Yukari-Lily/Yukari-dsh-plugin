/**
 * Plugin-owned switches for Unrestricted Mode.
 *
 * Precedence: built-in defaults < the row's config in `cordis.patch.yml` <
 * `$DSH_HOME/yukari-purge-settings.json`. The file is written atomically so a
 * crash mid-save can never leave a half-written JSON that disables the mode.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Every switch is on by default: the mode exists to remove friction. */
export const DEFAULT_SETTINGS = Object.freeze({
  anchor: true,
  refusalRetry: true,
  stripHostLimits: true,
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
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  return next
}
