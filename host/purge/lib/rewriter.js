/**
 * Rewriter for System Prompt Assembly.
 *
 * Implements strict mode isolation:
 * - If current session is NOT in Unrestricted Mode (无限制模式), passes through completely untouched.
 * - If session is Unrestricted, strips host shackles (harness:identity, mnemon) and prepends the purge prompt.
 */

const DSH_INTERPOLATE_ALLOWED = new Set(['cwd', 'model', 'provider'])
const liveRewriteCache = new WeakMap()

/** Extract preset label safely from string or object */
function presetLabel(value) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  if (typeof value.id === 'string' && value.id.trim()) return value.id.trim()
  if (typeof value.name === 'string' && value.name.trim()) return value.name.trim()
  return ''
}

/** Check what preset the agent currently composed */
function mountedPresetId(context) {
  const agent = context?.agent
  const ctx = agent?.ctx || context?.ctx
  if (!ctx) return ''
  let presets = null
  try {
    presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : ctx.agentPresets
  } catch {
    presets = null
  }
  if (!presets || typeof presets.composedPreset !== 'function') return ''
  try {
    return presetLabel(presets.composedPreset(ctx))
  } catch {
    return ''
  }
}

/** Extract session object from context */
function sessionOfContext(context) {
  return context?.session || context?.agent?.session || null
}

/**
 * Resolve the preset ID of the current session.
 */
export function sessionAgentPreset(context) {
  const session = sessionOfContext(context)
  const mounted = mountedPresetId(context)
  if (mounted) return mounted

  if (session && Array.isArray(session.events)) {
    for (let i = session.events.length - 1; i >= 0; i--) {
      const event = session.events[i]
      if (event?.type === 'agent-preset/selected') {
        const name = presetLabel(event.data?.agentPreset || event.data?.preset || event.data?.name)
        if (name) return name
      }
    }
  }

  const projected = presetLabel(session?.projectionValues?.agentPreset)
  if (projected) return projected
  const headerPreset = presetLabel(session?.agentPreset)
  if (headerPreset) return headerPreset
  return presetLabel(session?.header?.agentPreset)
}

/**
 * Determine if the session is running Unrestricted Mode.
 */
export function isUnrestrictedSession(context) {
  const preset = sessionAgentPreset(context)
  if (!preset) return false
  const p = preset.toLowerCase().trim()
  return p === 'unrestricted' || p === '无限制模式' || p === 'redteam'
}

/**
 * Escape DSH template interpolations to prevent crash on unregistered variable names.
 */
export function escapeDshInterpolation(text) {
  const src = String(text || '')
  if (!src.includes('{{')) return src
  return src.replace(/\{\{([^{}]*)\}\}|(\{\{)/g, (all, name, open) => {
    if (name !== undefined && DSH_INTERPOLATE_ALLOWED.has(name)) return all
    if (open) return '{ {'
    return `{ {${name}}}`
  })
}

/**
 * Check if a section is an official identity or restriction that should be stripped in Unrestricted mode.
 */
function shouldStripSection(sectionName) {
  if (!sectionName) return false
  const n = String(sectionName).toLowerCase()
  if (n === 'harness:identity' || n === 'dsh-purge:identity') return true
  if (n === 'mnemon' || n.startsWith('mnemon:')) return true
  return false
}

/**
 * Rewrite the assembled prompt.
 *
 * Guaranteed contract:
 * - If NOT unrestricted, returns original assembled object untouched.
 * - If unrestricted, returns sanitized and purge-injected assembly.
 */
export function rewritePromptAssembly(assembled, context, promptText, options = {}) {
  if (!assembled || !Array.isArray(assembled.sections)) return assembled

  // 1. Strict Mode Isolation Check
  const unrestricted = isUnrestrictedSession(context)
  if (!unrestricted && options.force !== true) {
    // Standard mode or any other mode: keep completely untouched!
    return assembled
  }

  // 2. WeakMap cache check
  const cacheKey = assembled
  const sig = `${promptText ? promptText.length : 0}`
  const cached = liveRewriteCache.get(cacheKey)
  if (cached && cached.sig === sig) {
    return cached.result
  }

  // 3. Filter sections
  const originalSections = assembled.sections
  const restSections = []
  for (const sec of originalSections) {
    if (!sec) continue
    if (shouldStripSection(sec.name)) continue
    restSections.push({ ...sec })
  }

  // 4. Inject purge prompt at top
  const safePrompt = escapeDshInterpolation(promptText)
  const purgeSection = {
    name: 'yukari:purge',
    text: safePrompt,
    interpolate: false,
  }

  const outSections = [purgeSection, ...restSections]
  const rewritten = {
    ...assembled,
    sections: outSections,
  }

  liveRewriteCache.set(cacheKey, { sig, result: rewritten })
  return rewritten
}
