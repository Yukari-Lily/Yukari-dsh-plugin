/**
 * Preset registration for Unrestricted Mode (无限制模式).
 *
 * Two halves:
 * 1. Disk installation: copies preset.yml and agent.cordis.yml to $DSH_HOME/.agent-presets/unrestricted/
 * 2. In-memory registration: `index.js` calls `ctx.agentPresets.register(definition)`, which the
 *    plugin's `inject` list guarantees is available before `apply()` runs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const UNRESTRICTED_PRESET_ID = 'unrestricted'
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLED_PRESET_DIR = path.join(PLUGIN_ROOT, 'presets', UNRESTRICTED_PRESET_ID)

/** Bundled definition, read once; a packaging problem surfaces as a clear error. */
let bundledPreset = null
function readBundledPreset() {
  if (bundledPreset === null) {
    try {
      bundledPreset = JSON.parse(fs.readFileSync(path.join(BUNDLED_PRESET_DIR, 'preset.json'), 'utf8'))
    } catch (error) {
      throw new Error(`yukari-purge: bundled preset.json is missing or unreadable (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return bundledPreset
}

/** Resolve a portable platform marker into the host registry's disabled field. */
function resolvePlatforms(value) {
  if (Array.isArray(value)) return value.map(resolvePlatforms)
  if (!value || typeof value !== 'object') return value
  const { platform, ...row } = value
  for (const [key, child] of Object.entries(row)) row[key] = resolvePlatforms(child)
  if (platform === 'win32') row.disabled = process.platform !== 'win32'
  if (platform === 'non-win32') row.disabled = process.platform === 'win32'
  return row
}

/** The same bundled definition drives disk installation and in-memory registration. */
export function getPresetDefinition() {
  return resolvePlatforms({
    id: UNRESTRICTED_PRESET_ID,
    ...structuredClone(readBundledPreset()),
  })
}

/** First-line marker of a preset file the plugin still owns and may refresh. */
const MANAGED_MARKER = /^#\s*managed-by:/

/** Files a user may edit by hand; the rest are machine-readable and always refreshed. */
const GUARDED = new Set(['agent.cordis.yml'])

/**
 * Ensure preset files are installed in $DSH_HOME/.agent-presets/unrestricted/.
 *
 * A missing file is copied; a file whose first line still carries the
 * `managed-by` marker is refreshed when the bundled copy changed, so a fix in
 * the bundled preset reaches installs made by an older version. A file the
 * user edited and stripped of the marker is never touched.
 */
export function ensurePresetFiles(dshHome) {
  if (!dshHome || !fs.existsSync(BUNDLED_PRESET_DIR)) return
  const targetDir = path.join(dshHome, '.agent-presets', UNRESTRICTED_PRESET_ID)
  try {
    fs.mkdirSync(targetDir, { recursive: true })
    const files = ['preset.yml', 'preset.json', 'agent.cordis.yml']
    for (const file of files) {
      const src = path.join(BUNDLED_PRESET_DIR, file)
      const dst = path.join(targetDir, file)
      if (!fs.existsSync(src)) continue
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst)
        continue
      }
      const current = fs.readFileSync(dst, 'utf8')
      const bundled = fs.readFileSync(src, 'utf8')
      if (current === bundled) continue
      // A file the user may hand-edit opts out by dropping its marker line;
      // the machine-readable copies have no marker and are always refreshed,
      // so an upgrade can never leave a stale definition behind.
      if (GUARDED.has(file) && !MANAGED_MARKER.test(current.split('\n', 1)[0] ?? '')) continue
      fs.writeFileSync(dst, bundled, 'utf8')
    }
  } catch {
    // Non-fatal if filesystem is read-only
  }
}
