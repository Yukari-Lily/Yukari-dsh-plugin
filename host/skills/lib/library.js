/**
 * The skill library on disk: discovery, reading, writing and the enabled flag.
 *
 * A skill is one entry directly inside the user root `$DSH_HOME/skills` — a
 * directory bundle `<key>/SKILL.md` or a flat file `<key>.md` — exactly the two
 * shapes `dsh-skill-filesystem` discovers. Nothing else is touched: nested
 * trees, other extensions and the `.system` child the host skips stay invisible
 * here as well.
 *
 * Disabling is a move, not an edit: a disabled bundle lives in
 * `$DSH_HOME/skills-disabled`, a directory the provider never scans, so the
 * skill leaves both the model catalog and the `/` menu while its files stay
 * byte-for-byte intact. Enabling moves it back. Moving out of a watched root is
 * also what tells the host to refresh, so neither direction needs a restart.
 * @module yukari-dsh-plugin/skills/lib/library
 */
import { constants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { appError, messageOf } from '../../shared/http.js'
import { resolveDshHome } from '../../shared/home.js'
import { readSkillText } from './frontmatter.js'

/** The two shapes one skill can take. */
export const FORMS = ['bundle', 'file']

/** A skill body larger than this is truncated in the editor and refused on save. */
export const MAX_TEXT_BYTES = 256 * 1024

/** Discovery reads only the frontmatter, so a bounded head is enough. */
const HEAD_BYTES = 64 * 1024

/** The user root and the disabled store, both under the harness home. */
export function libraries() {
  const home = resolveDshHome()
  return { root: path.join(home, 'skills'), disabledRoot: path.join(home, 'skills-disabled') }
}

/**
 * Refuse anything that is not one plain path segment.
 *
 * Keys come straight from HTTP and end up in a path join: a separator, `..` or
 * a leading dot would reach outside the library.
 * @param key - entry name supplied by the panel.
 * @returns the key.
 */
export function assertKey(key) {
  const value = typeof key === 'string' ? key : ''
  if (value === '' || value === '.' || value === '..' || value.startsWith('.') || /[/\\\0]/u.test(value)) {
    throw appError('技能标识不合法。', 'skill-key-invalid')
  }
  return value
}

/** Refuse an unknown form. */
export function assertForm(form) {
  if (!FORMS.includes(form)) throw appError('技能形态不合法。', 'skill-form-invalid')
  return form
}

/**
 * Absolute path of one skill entry.
 * @param base - the library directory it lives in.
 * @param key - entry name.
 * @param form - `bundle` or `file`.
 */
function itemPath(base, key, form) {
  return form === 'bundle' ? path.join(base, key) : path.join(base, `${key}.md`)
}

/** The instruction file of one entry. */
function skillFile(base, key, form) {
  return form === 'bundle' ? path.join(base, key, 'SKILL.md') : path.join(base, `${key}.md`)
}

/** `lstat` that answers null instead of throwing for a missing path. */
async function statOrNull(target) {
  try {
    return await lstat(target)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

/** Read at most `limit` bytes from the start of a file. */
async function readHead(file, limit) {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    const length = Math.min(info.size, limit)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), size: info.size, mtime: info.mtimeMs }
  } finally {
    await handle.close()
  }
}

/** Every skill entry one library directory holds. */
export async function listEntries(base) {
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
  const found = []
  for (const entry of entries) {
    // `.system` is the host's own child and never a skill; a symlink could point
    // anywhere, and every action here moves or deletes what it names.
    if (entry.name === '.system' || entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      // 没有 SKILL.md 的目录不是技能包，宿主也不会加载它。
      if ((await statOrNull(path.join(base, entry.name, 'SKILL.md'))) !== null) found.push({ key: entry.name, form: 'bundle' })
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push({ key: entry.name.slice(0, -3), form: 'file' })
    }
  }
  return found
}

/** Recursive byte size, ignoring symlinks so a link cannot inflate the count. */
async function directorySize(directory) {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += await directorySize(child)
    else if (entry.isFile()) total += (await lstat(child)).size
  }
  return total
}

/**
 * Describe one entry as the panel sees it.
 * @param base - library directory holding it.
 * @param state - `enabled` or `disabled`.
 * @param key - entry name.
 * @param form - `bundle` or `file`.
 */
async function describeEntry(base, state, key, form) {
  const target = itemPath(base, key, form)
  const file = skillFile(base, key, form)
  const item = { key, form, state, name: key, description: '', whenToUse: '', modelInvocable: true, userInvocable: true, path: file, size: 0, mtime: null, problem: null, detail: null }
  let head
  try {
    head = await readHead(file, HEAD_BYTES)
  } catch (error) {
    return { ...item, problem: 'unreadable', detail: `读不到这个技能：${messageOf(error)}` }
  }
  const parsed = readSkillText(head.text)
  try {
    item.size = form === 'bundle' ? await directorySize(target) : head.size
  } catch {
    item.size = head.size
  }
  return {
    ...item,
    name: parsed.problem === null ? parsed.name : key,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    modelInvocable: parsed.modelInvocable,
    userInvocable: parsed.userInvocable,
    mtime: head.mtime,
    problem: parsed.problem,
    detail: parsed.detail,
  }
}

/**
 * Every skill the library holds, enabled first and each group sorted by name.
 * @returns items as {@link describeEntry} builds them.
 */
export async function scan() {
  const { root, disabledRoot } = libraries()
  const items = []
  for (const [base, state] of [
    [root, 'enabled'],
    [disabledRoot, 'disabled'],
  ]) {
    for (const entry of await listEntries(base)) items.push(await describeEntry(base, state, entry.key, entry.form))
  }
  const rank = (item) => (item.state === 'enabled' ? 0 : 1)
  items.sort((left, right) => rank(left) - rank(right) || left.key.localeCompare(right.key))
  return items
}

/** Find one entry in either library; `null` when neither holds it. */
async function locate(key, form) {
  const { root, disabledRoot } = libraries()
  for (const [base, state] of [
    [root, 'enabled'],
    [disabledRoot, 'disabled'],
  ]) {
    if ((await statOrNull(itemPath(base, key, form))) !== null) return { base, state }
  }
  return null
}

/**
 * Read one skill file for the editor.
 * @param key - entry name.
 * @param form - `bundle` or `file`.
 */
export async function readSkill(key, form) {
  const found = await locate(key, form)
  if (found === null) throw appError('找不到这个技能。', 'skill-not-found', undefined, 404)
  const head = await readHead(skillFile(found.base, key, form), MAX_TEXT_BYTES)
  const full = await stat(skillFile(found.base, key, form))
  const item = await describeEntry(found.base, found.state, key, form)
  return { item, text: head.text, truncated: full.size > MAX_TEXT_BYTES }
}

/** Write a file atomically: the visible path is either old or new, never half. */
async function writeAtomic(file, text) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o644 })
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * Validate skill text and report the reasons it would not load.
 * @param text - candidate file body.
 * @returns the parsed fields.
 */
function validate(text) {
  if (Buffer.byteLength(String(text ?? ''), 'utf8') > MAX_TEXT_BYTES) {
    throw appError(`技能正文超过 ${Math.round(MAX_TEXT_BYTES / 1024)} KB，请精简后再保存。`, 'skill-text-too-large')
  }
  const parsed = readSkillText(text)
  if (parsed.problem !== null) throw appError(parsed.detail, 'skill-invalid', { problem: parsed.problem })
  return parsed
}

/**
 * Save edited text over an existing skill.
 * @param key - entry name.
 * @param form - `bundle` or `file`.
 * @param text - new file body.
 */
export async function saveSkill(key, form, text) {
  const found = await locate(key, form)
  if (found === null) throw appError('找不到这个技能。', 'skill-not-found', undefined, 404)
  const parsed = validate(text)
  await writeAtomic(skillFile(found.base, key, form), text)
  const item = await describeEntry(found.base, found.state, key, form)
  return { item, notes: parsed.name !== key ? ['name-differs'] : [] }
}

/** Refuse a move whose destination is already taken, in either shape. */
async function assertFree(base, key, form) {
  for (const other of FORMS) {
    if (await statOrNull(itemPath(base, key, other)) !== null) {
      throw appError(`「${key}」在目标目录里已经存在，请先处理同名条目。`, 'skill-exists')
    }
  }
}

/** Move one entry across libraries, falling back to a copy when rename cannot cross devices. */
async function moveEntry(from, to, key, form) {
  try {
    await rename(itemPath(from, key, form), itemPath(to, key, form))
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  const target = itemPath(to, key, form)
  if (form === 'bundle') {
    try {
      await cp(itemPath(from, key, form), target, { recursive: true, errorOnExist: true, force: false })
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    await rm(itemPath(from, key, form), { recursive: true, force: true })
    return
  }
  try {
    await copyFile(itemPath(from, key, form), target, constants.COPYFILE_EXCL)
  } catch (error) {
    await rm(target, { force: true }).catch(() => {})
    throw error
  }
  await unlink(itemPath(from, key, form))
}

/**
 * Turn one skill on or off by moving it between the two libraries.
 * @param key - entry name.
 * @param form - `bundle` or `file`.
 * @param enabled - target state.
 */
export async function setEnabled(key, form, enabled) {
  const { root, disabledRoot } = libraries()
  const found = await locate(key, form)
  if (found === null) throw appError('找不到这个技能。', 'skill-not-found', undefined, 404)
  const wanted = enabled === true ? 'enabled' : 'disabled'
  if (found.state === wanted) return describeEntry(found.base, found.state, key, form)
  const destination = wanted === 'enabled' ? root : disabledRoot
  await mkdir(destination, { recursive: true })
  await assertFree(destination, key, form)
  await moveEntry(found.base, destination, key, form)
  return describeEntry(destination, wanted, key, form)
}

/**
 * Delete one skill, whichever library holds it.
 * @param key - entry name.
 * @param form - `bundle` or `file`.
 */
export async function removeSkill(key, form) {
  const found = await locate(key, form)
  if (found === null) throw appError('找不到这个技能。', 'skill-not-found', undefined, 404)
  const target = itemPath(found.base, key, form)
  if (form === 'bundle') await rm(target, { recursive: true, force: false })
  else await unlink(target)
  return { key, form, state: found.state }
}

/**
 * The files one download archive carries.
 *
 * Symlinks are skipped rather than followed: an archive must not smuggle in a
 * file from outside the skill directory.
 * @param key - entry name.
 * @param form - `bundle` or `file`.
 */
export async function archiveEntries(key, form) {
  const found = await locate(key, form)
  if (found === null) throw appError('找不到这个技能。', 'skill-not-found', undefined, 404)
  const item = await describeEntry(found.base, found.state, key, form)
  const prefix = item.name === '' ? key : item.name
  if (form === 'file') return { entries: [{ name: `${prefix}.md`, path: skillFile(found.base, key, form) }], item }
  const entries = []
  const visit = async (directory, relative) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        entries.push({ name: `${prefix}/${name}/`, path: absolute, directory: true })
        await visit(absolute, name)
      } else if (entry.isFile()) {
        entries.push({ name: `${prefix}/${name}`, path: absolute })
      }
    }
  }
  await visit(itemPath(found.base, key, form), '')
  return { entries, item }
}

/**
 * Install a flat skill file.
 * @param text - file body.
 * @param filename - name the upload arrived with, for the error message only.
 */
export async function installFlat(text, filename) {
  const parsed = validate(text)
  const { root } = libraries()
  await mkdir(root, { recursive: true })
  for (const other of FORMS) {
    if ((await statOrNull(itemPath(root, parsed.name, other))) !== null) {
      throw appError(`已经有一个叫「${parsed.name}」的技能了，请先删除或改名（上传的文件是「${filename}」）。`, 'skill-exists')
    }
  }
  await writeAtomic(path.join(root, `${parsed.name}.md`), text)
  const item = await describeEntry(root, 'enabled', parsed.name, 'file')
  return { item, notes: [] }
}

/**
 * Install an extracted bundle directory under a fresh name.
 * @param source - directory holding `SKILL.md`.
 * @param parsed - validated frontmatter.
 */
export async function installBundle(source, parsed) {
  const { root } = libraries()
  await mkdir(root, { recursive: true })
  for (const other of FORMS) {
    if ((await statOrNull(itemPath(root, parsed.name, other))) !== null) {
      throw appError(`已经有一个叫「${parsed.name}」的技能了，请先删除。`, 'skill-exists')
    }
  }
  const target = itemPath(root, parsed.name, 'bundle')
  try {
    await cp(source, target, { recursive: true, errorOnExist: true, force: false })
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  const item = await describeEntry(root, 'enabled', parsed.name, 'bundle')
  return { item, notes: [] }
}

/**
 * Whether a path exists, for the uploader's collision checks.
 * @param target - absolute path.
 */
export async function exists(target) {
  return (await statOrNull(target)) !== null
}
