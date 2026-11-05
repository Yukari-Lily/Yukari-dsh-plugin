/**
 * Preset registration for Unrestricted Mode (无限制模式).
 *
 * Provides dual registration:
 * 1. Disk installation: copies preset.yml and agent.cordis.yml to $DSH_HOME/.agent-presets/unrestricted/
 * 2. In-memory registration: calls ctx.agentPresets.register(definition) once the registry service is ready.
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
      if (current !== bundled && MANAGED_MARKER.test(current.split('\n', 1)[0] ?? '')) {
        fs.writeFileSync(dst, bundled, 'utf8')
      }
    }
  } catch {
    // Non-fatal if filesystem is read-only
  }
}

/**
 * Register the preset into Cordis agentPresets registry when available.
 */
export function registerPresetService(ctx) {
  let release = null
  let stopped = false
  let tries = 0
  const maxTries = 40

  const getRegistry = () => {
    try {
      const p = ctx.agentPresets
      if (p && typeof p.register === 'function') return p
    } catch {}
    try {
      const g = ctx.get?.('agentPresets')
      if (g && typeof g.register === 'function') return g
    } catch {}
    return null
  }

  const declare = async () => {
    if (stopped) return
    const reg = getRegistry()
    if (!reg) {
      if (tries++ < maxTries) setTimeout(declare, 500)
      return
    }

    try {
      const definition = getPresetDefinition()
      release = await reg.register(definition)
      if (stopped) {
        if (typeof release === 'function') await release()
        release = null
        return
      }
      ctx.logger?.info?.('yukari-purge: 已成功注册预设 [无限制模式]')
    } catch (err) {
      const msg = String(err?.message || err)
      if (!/already|duplicate/i.test(msg)) {
        ctx.logger?.warn?.('yukari-purge: 注册预设失败: %s', msg)
        if (tries++ < maxTries) setTimeout(declare, 1000)
      }
    }
  }

  declare()

  return () => {
    stopped = true
    if (typeof release === 'function') {
      try {
        release()
      } catch {}
    }
  }
}
