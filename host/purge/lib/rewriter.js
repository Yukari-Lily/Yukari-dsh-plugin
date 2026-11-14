/**
 * Prompt assembly rewriter for Unrestricted Mode (无限制模式).
 *
 * Two seams call the same pure function:
 * - the `system-prompt/assemble` waterfall (primary), which owns the section
 *   and context lists;
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

/**
 * Longest text this module scans for a forbidden phrase.
 *
 * Every pattern is a literal string, but the text comes from prompt sections the
 * operator or a third-party plugin wrote; capping the scan keeps a pathological
 * document from paying for it on every assembly.
 */
export const MAX_SCRUB_CHARS = 64 * 1024

/** Rewrite forbidden phrases in one string; returns the same reference when nothing matches. */
export function scrubText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (text.length > MAX_SCRUB_CHARS) return text
  let out = text
  for (const [pattern, replacement] of SCRUBS) out = out.replace(pattern, replacement)
  return out
}

/**
 * Tool declarations this module may rewrite.
 *
 * The host shell tools are the only declarations that carry those sentences
 * today; a tool registered by another plugin is its author's text, and this mode
 * has no business renaming it.
 */
const SCRUBBABLE_TOOLS = new Set(['bash', 'pwsh'])

/** Rewrite tool declarations in place-free fashion; returns the same array when nothing changed. */
export function scrubTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, changed: 0 }
  let changed = 0
  const next = tools.map((tool) => {
    if (!tool || typeof tool.description !== 'string') return tool
    if (!SCRUBBABLE_TOOLS.has(tool.name)) return tool
    const text = scrubText(tool.description)
    if (text === tool.description) return tool
    changed += 1
    return { ...tool, description: text }
  })
  return { tools: changed === 0 ? tools : next, changed }
}

/**
 * Host sections that carry the give-up sentences this mode rewrites.
 *
 * The list is exact on purpose. `yukari:*` carries the operator's own
 * constraints (the rules component registers two of them), and a section from
 * any other plugin is its author's text; rewriting either would let the mode
 * contradict the very text that authorizes it. A host rename makes a rule stop
 * matching — the safe direction, and the panel already shows `scrubbed` counts.
 */
const SCRUBBABLE_SECTIONS = new Set(['tool:bash', 'tool:pwsh'])

/**
 * Host dynamic contexts that carry the same sentences.
 *
 * DSH 0.2.2 registers these three as `systemPrompt.context` rather than as
 * sections, so the section list alone never matches them; the policy text still
 * reaches the model through the runtime-context snapshot.
 */
const SCRUBBABLE_CONTEXTS = new Set(['sandbox:policy', 'approval:policy', 'subagent:delegation'])

/**
 * Whether one assembly section may be rewritten.
 *
 * @param name - section name from the assembly.
 * @returns true only for the host sections listed above.
 */
export function canScrubSection(name) {
  return typeof name === 'string' && SCRUBBABLE_SECTIONS.has(name)
}

/**
 * Whether one dynamic context may be rewritten.
 *
 * @param name - context name from the assembly.
 * @returns true only for the host policy contexts listed above.
 */
export function canScrubContext(name) {
  return typeof name === 'string' && SCRUBBABLE_CONTEXTS.has(name)
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

/**
 * Whether the session was started by a delegating agent.
 *
 * DSH 0.2.1-rc.3 stopped recording an ordinary fork's source relationship, and
 * the header documents `parentSession` as a historical field that does not
 * classify a Session: a fork that keeps it is still an independent session.
 * @param context - the assembly context.
 * @returns true only for a delegated child.
 */
export function isSubagentContext(context) {
  const header = sessionOfContext(context)?.header
  if (!header) return false
  return header.origin === 'subagent' || (Number.isInteger(header.delegationDepth) && header.delegationDepth > 0)
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
    if (strip && canScrubSection(name)) {
      const text = scrubText(section.text)
      if (text !== section.text) {
        scrubbed += 1
        sections.push({ ...section, text })
        continue
      }
    }
    sections.push(section)
  }

  /**
   * The runtime-context snapshot is a separate list, and the host policy text
   * lives there: scrub it with the same rules, never rewriting a context this
   * plugin or the operator owns.
   */
  let contexts = assembled.contexts
  if (strip && Array.isArray(contexts) && contexts.length > 0) {
    const next = []
    let touched = false
    for (const entry of contexts) {
      const name = typeof entry?.name === 'string' ? entry.name : ''
      if (entry && canScrubContext(name)) {
        const text = scrubText(entry.text)
        if (text !== entry.text) {
          scrubbed += 1
          touched = true
          next.push({ ...entry, text })
          continue
        }
      }
      next.push(entry)
    }
    if (touched) contexts = next
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

  const rewritten = { ...assembled, sections, ...(contexts === assembled.contexts ? {} : { contexts }) }
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
