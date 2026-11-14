/**
 * SKILL.md frontmatter, read with the host's own grammar.
 *
 * The panel has to answer one question before it writes anything: will the host
 * provider actually load this file? Answering it with a hand-rolled parser would
 * disagree on block scalars (`description: |`), quoted values and nested
 * metadata — the shapes real skill files use — so the YAML document is parsed by
 * `yaml`, the same library `dsh-skill-filesystem` uses, and the field rules
 * below are copied from it: kebab-case `name`, required `description`, the two
 * invocation keys with their accepted boolean spellings, and the legacy keys the
 * host rejects outright.
 *
 * A malformed file is reported, never thrown: the panel lists it with a reason
 * instead of hiding it, because "why is my skill missing" is the question this
 * page exists to answer.
 * @module yukari-dsh-plugin/skills/lib/frontmatter
 */
import { parse as parseYaml } from 'yaml'

/** The public skill-name grammar, identical to `dsh-skill`. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Keys the host refuses; each maps to the canonical replacement. */
const LEGACY_KEYS = {
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
}

/** Why a file would not load, and what to tell the operator. */
const PROBLEMS = {
  'no-frontmatter': '文件必须以一行「---」开头的 YAML 前言开始，否则宿主读不到技能信息。',
  'bad-yaml': '前言不是有效的 YAML。',
  'missing-name': '前言缺少 name。',
  'missing-description': '前言缺少 description。',
  'bad-name': 'name 必须是 kebab-case：小写字母、数字，用「-」分隔。',
  'bad-invocation': '调用开关的取值不合法，只能是 true 或 false。',
}

/**
 * Locate the YAML frontmatter exactly the way the host does: the first line is
 * `---`, the block ends at the next line that is only `---`.
 * @param text - the whole file.
 * @returns `{ yaml, body }`, or null when there is no frontmatter block.
 */
function splitFrontmatter(text) {
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0) return null
  if (text.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return null
  let lineStart = firstLineEnd + 1
  while (lineStart <= text.length) {
    const nextNewline = text.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? text.length : nextNewline
    if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      const bodyStart = nextNewline < 0 ? text.length : nextNewline + 1
      return { yaml: text.slice(firstLineEnd + 1, lineStart), body: text.slice(bodyStart) }
    }
    if (nextNewline < 0) return null
    lineStart = nextNewline + 1
  }
  return null
}

/** One non-empty string field, or undefined. */
function textField(data, key) {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read one boolean the way the host does: a YAML boolean, `1`/`0`, `"1"`/`"0"`,
 * or the case-insensitive words true/yes/on and false/no/off.
 * @param data - frontmatter mapping.
 * @param key - field name.
 * @returns the boolean, undefined when absent.
 */
function booleanField(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`${key} must be a boolean`)
}

/**
 * Parse one skill file.
 *
 * The result always carries the fields the panel displays; `problem` is the
 * reason the host would skip the file, and is null for a loadable skill.
 * @param text - the whole file.
 * @returns `{ name, description, whenToUse, modelInvocable, userInvocable, problem, detail }`.
 */
export function readSkillText(text) {
  const empty = { name: '', description: '', whenToUse: '', modelInvocable: true, userInvocable: true }
  const split = splitFrontmatter(String(text ?? ''))
  if (split === null) return { ...empty, problem: 'no-frontmatter', detail: PROBLEMS['no-frontmatter'] }

  let data
  try {
    data = parseYaml(split.yaml)
  } catch (error) {
    return { ...empty, problem: 'bad-yaml', detail: `${PROBLEMS['bad-yaml']}（${String(error?.message ?? error).split('\n')[0]}）` }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ...empty, problem: 'bad-yaml', detail: PROBLEMS['bad-yaml'] }
  }

  const name = textField(data, 'name')
  const description = textField(data, 'description')
  const whenToUse = textField(data, 'whenToUse') ?? ''
  const base = { name: name ?? '', description: description ?? '', whenToUse, modelInvocable: true, userInvocable: true }
  if (name === undefined) return { ...base, problem: 'missing-name', detail: PROBLEMS['missing-name'] }
  if (description === undefined) return { ...base, problem: 'missing-description', detail: PROBLEMS['missing-description'] }
  if (!SKILL_NAME.test(name)) return { ...base, problem: 'bad-name', detail: PROBLEMS['bad-name'] }

  for (const [legacy, canonical] of Object.entries(LEGACY_KEYS)) {
    if (Object.hasOwn(data, legacy)) {
      return { ...base, problem: 'bad-invocation', detail: `前言里的 ${legacy} 已废弃，请改用 ${canonical}。` }
    }
  }
  try {
    const disableModel = booleanField(data, 'disable-model-invocation')
    const userInvocable = booleanField(data, 'user-invocable')
    return {
      name,
      description,
      whenToUse,
      modelInvocable: disableModel !== true,
      userInvocable: userInvocable !== false,
      problem: null,
      detail: null,
    }
  } catch (error) {
    return { ...base, problem: 'bad-invocation', detail: `${PROBLEMS['bad-invocation']}（${String(error?.message ?? error)}）` }
  }
}
