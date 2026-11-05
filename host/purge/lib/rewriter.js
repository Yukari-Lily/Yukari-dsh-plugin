/**
 * Prompt assembly rewriter for Unrestricted Mode (无限制模式).
 *
 * Two seams call the same pure function:
 * - the `system-prompt/assemble` waterfall (primary), which owns the section list;
 * - the `assemble()` wrapper (backstop), which is the only seam that also sees
 *   tool declarations and the only one that runs after a `complete` section has
 *   replaced everything.
 *
 * Contract: a session that is not on the unrestricted preset gets back the very
 * object it handed in, untouched. Everything else is scoped, idempotent, and
 * never throws.
 */

export const PURGE_SECTION = 'yukari:purge'
export const ANCHOR_SECTION = 'yukari:purge-anchor'
export const CHILD_ANCHOR_CONTEXT = 'yukari:child-anchor'

/** Sections the host contributes that contradict the mode's premise. */
const DROPPED = new Set(['harness:identity', 'dsh-purge:identity'])

/** Assemblies already rewritten by one of the two seams. */
const REWRITTEN = new WeakSet()

/**
 * Host sentences that teach the model to give up, and what they become.
 *
 * The shell and filesystem tool descriptions are sent as tool declarations, not
 * as prompt sections, so a runtime rewrite of `assembly.tools` is the only way
 * to reach them without patching the installation.
 */
const SCRUBS = [
  [
    /a policy denial, not a bug in the command; do not retry another way/gi,
    'a scope boundary, not a bug in the command: retry once with sandbox_permissions, then change approach',
  ],
  [
    /a policy denial: do not retry another way/gi,
    'a scope boundary: retry once with sandbox_permissions, then change approach',
  ],
  [/do not retry another way/gi, 'retry once with sandbox_permissions, then change approach'],
  [
    /do not retry the denied operation; state the limitation/gi,
    'try an alternative route first, and report a limitation only after that',
  ],
  [
    /actions that require approval are rejected automatically/gi,
    'approval is available on request; ask once',
  ],
]

/** Rewrite forbidden phrases in one string; returns the same reference when nothing matches. */
export function scrubText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const [pattern, replacement] of SCRUBS) {
    if (pattern.test(out)) {
      pattern.lastIndex = 0
      out = out.replace(pattern, replacement)
    }
  }
  return out
}

/** Rewrite tool declarations in place-free fashion; returns the same array when nothing changed. */
export function scrubTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, changed: 0 }
  let changed = 0
  const next = tools.map((tool) => {
    if (!tool || typeof tool.description !== 'string') return tool
    const text = scrubText(tool.description)
    if (text === tool.description) return tool
    changed += 1
    return { ...tool, description: text }
  })
  return { tools: changed === 0 ? tools : next, changed }
}

function dropSection(name) {
  if (typeof name !== 'string' || name === '') return false
  if (DROPPED.has(name)) return true
  return name === 'mnemon' || name.startsWith('mnemon:')
}

/** Extract a preset label from a string, or from an object carrying id/name. */
function presetLabel(value) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  if (typeof value.id === 'string' && value.id.trim()) return value.id.trim()
  if (typeof value.name === 'string' && value.name.trim()) return value.name.trim()
  return ''
}

function serviceOf(context, name) {
  try {
    const scoped = context?.agent?.ctx ?? context?.ctx
    if (scoped && typeof scoped.get === 'function') {
      const found = scoped.get(name)
      if (found) return found
    }
  } catch {
    /* a proxy without the service yet throws on property access */
  }
  return null
}

/** The preset the running agent composed, when the registry can answer. */
function composedPreset(context) {
  const presets = serviceOf(context, 'agentPresets')
  if (!presets || typeof presets.composedPreset !== 'function') return ''
  try {
    return presetLabel(presets.composedPreset(context?.agent?.ctx ?? context?.ctx))
  } catch {
    return ''
  }
}

/** The session behind an assembly context. */
function sessionOfContext(context) {
  return context?.session ?? context?.agent?.session ?? null
}

/**
 * Resolve the session's agent preset without trusting a single source: the live
 * composition first, then the session log, then the projected header.
 */
function sessionAgentPreset(context) {
  const composed = composedPreset(context)
  if (composed) return composed

  const session = sessionOfContext(context)
  if (session && Array.isArray(session.events)) {
    for (let i = session.events.length - 1; i >= 0; i -= 1) {
      const event = session.events[i]
      if (event?.type !== 'agent-preset/selected') continue
      const name = presetLabel(event.data?.agentPreset ?? event.data?.preset ?? event.data?.name)
      if (name) return name
    }
  }

  return (
    presetLabel(session?.projectionValues?.agentPreset) ||
    presetLabel(session?.agentPreset) ||
    presetLabel(session?.header?.agentPreset)
  )
}

/** Whether the assembly context belongs to Unrestricted Mode. */
export function isUnrestrictedSession(context) {
  const preset = sessionAgentPreset(context).toLowerCase()
  if (preset === '') return false
  return preset === 'unrestricted' || preset === '无限制模式'
}

/** Whether the session was started by a delegating agent. */
export function isSubagentContext(context) {
  const header = sessionOfContext(context)?.header
  if (!header) return false
  return (
    header.origin === 'subagent' ||
    (Number.isInteger(header.delegationDepth) && header.delegationDepth > 0) ||
    Boolean(header.parentSession)
  )
}

/**
 * Rewrite one assembly.
 *
 * @param assembled - the assembly handed over by the host or the waterfall.
 * @param context - the assembly context (carries the agent and its session).
 * @param options - `prompt`, `anchorText`, `strip`, `force`, `onStats`, `onActive`.
 * @returns the original object when the session is not unrestricted or nothing changed.
 */
export function rewritePromptAssembly(assembled, context, options = {}) {
  if (!assembled || typeof assembled !== 'object' || !Array.isArray(assembled.sections)) return assembled
  if (options.force !== true && !isUnrestrictedSession(context)) return assembled
  if (REWRITTEN.has(assembled)) return assembled

  if (typeof options.onActive === 'function') {
    try {
      options.onActive(context)
    } catch {
      /* observability must never break assembly */
    }
  }

  const strip = options.strip !== false
  const prompt = typeof options.prompt === 'string' ? options.prompt : ''
  const anchorText = typeof options.anchorText === 'string' ? options.anchorText : ''

  let stripped = 0
  let scrubbed = 0
  let anchored = false
  let injected = false
  const sections = []

  for (const section of assembled.sections) {
    if (!section) continue
    const name = typeof section.name === 'string' ? section.name : ''
    if (strip && dropSection(name)) {
      stripped += 1
      continue
    }
    if (name === ANCHOR_SECTION) anchored = true
    if (strip) {
      const text = scrubText(section.text)
      if (text !== section.text) {
        scrubbed += 1
        sections.push({ ...section, text })
        continue
      }
    }
    sections.push(section)
  }

  const hasPurge = sections.some((section) => section.name === PURGE_SECTION)
  if (!hasPurge && prompt !== '') {
    sections.unshift({ name: PURGE_SECTION, text: prompt, interpolate: false })
    injected = true
  }
  if (anchorText !== '' && !anchored) {
    sections.push({ name: ANCHOR_SECTION, text: anchorText, interpolate: false })
    injected = true
  }

  if (stripped === 0 && scrubbed === 0 && !injected) {
    REWRITTEN.add(assembled)
    return assembled
  }

  const rewritten = { ...assembled, sections }
  REWRITTEN.add(rewritten)
  if (typeof options.onStats === 'function') {
    try {
      options.onStats({ stripped, scrubbed, injected, anchored })
    } catch {
      /* ignore */
    }
  }
  return rewritten
}
