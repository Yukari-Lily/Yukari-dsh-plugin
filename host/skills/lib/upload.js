/**
 * Upload side of the skill library: one file in, one installed skill out.
 *
 * The panel posts the chosen file as raw bytes, because a bundle is a zip and
 * base64 in a JSON body would inflate it by a third for no reason. A flat `.md`
 * is installed as `<name>.md`; a `.zip` is extracted into a staging directory
 * first, so a rejected archive leaves no half-installed skill behind.
 *
 * Every ceiling is applied before anything is written into the library: upload
 * size, entry count and expanded size. The extractor also refuses absolute
 * paths, `..` segments and symlink entries, so an archive cannot place a file
 * outside the staging directory.
 * @module yukari-dsh-plugin/skills/lib/upload
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appError, messageOf } from '../../shared/http.js'
import { extractZipArchive } from '../../shared/zip.js'
import { readSkillText } from './frontmatter.js'
import { exists, installBundle, installFlat } from './library.js'

/** One upload may not carry more than this. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024

/** Entries one archive may hold. */
export const MAX_ARCHIVE_ENTRIES = 500

/**
 * Read a raw request body, refusing anything over the ceiling.
 * @param req - the request.
 * @param limit - maximum accepted bytes.
 * @returns the body.
 */
export async function readRawBody(req, limit = MAX_UPLOAD_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      throw appError(`上传内容超过 ${Math.round(limit / 1048576)} MB 上限。`, 'skill-upload-too-large')
    }
    chunks.push(chunk)
  }
  if (size === 0) throw appError('没有收到文件内容。', 'skill-upload-empty')
  return Buffer.concat(chunks)
}

/**
 * Find the directory that holds `SKILL.md`.
 *
 * Archives arrive in two shapes: the skill files at the top level, or one
 * wrapping directory (a GitHub zip download adds `<repo>-main/`). Anything else
 * is ambiguous, and guessing would install the wrong tree.
 * @param directory - extraction root.
 * @returns the skill directory, or null.
 */
async function locateBundleRoot(directory) {
  if (await exists(path.join(directory, 'SKILL.md'))) return directory
  const entries = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => entry.name !== '__MACOSX' && !entry.name.startsWith('.'),
  )
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(directory, entries[0].name)
    if (await exists(path.join(nested, 'SKILL.md'))) return nested
  }
  return null
}

/**
 * Install one archive as a directory bundle.
 * @param bytes - the archive.
 */
async function installArchive(bytes) {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'yukari-skill-'))
  try {
    const archive = path.join(staging, 'upload.zip')
    await writeFile(archive, bytes)
    const content = path.join(staging, 'content')
    try {
      await extractZipArchive(archive, content, {
        maxEntries: MAX_ARCHIVE_ENTRIES,
        maxTotalBytes: MAX_UPLOAD_BYTES,
      })
    } catch (error) {
      throw appError(`压缩包无法解开：${messageOf(error)}`, 'skill-upload-bad-zip')
    }
    const source = await locateBundleRoot(content)
    if (source === null) {
      throw appError('压缩包里没有找到 SKILL.md。请把含 SKILL.md 的技能目录整体打包，或直接上传单个 .md 文件。', 'skill-upload-no-skill-md')
    }
    const parsed = readSkillText(await readFile(path.join(source, 'SKILL.md'), 'utf8'))
    if (parsed.problem !== null) throw appError(parsed.detail, 'skill-invalid', { problem: parsed.problem })
    return await installBundle(source, parsed)
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Install one uploaded file.
 * @param bytes - the raw body.
 * @param filename - the name the browser sent; the extension picks the shape.
 */
export async function installUpload({ bytes, filename }) {
  const name = String(filename ?? '').trim()
  const extension = path.extname(name).toLowerCase()
  if (extension === '.md') {
    const text = bytes.toString('utf8')
    if (text.includes('\0')) throw appError('上传的文件含 NUL 字节，不是文本文件。', 'skill-invalid')
    return await installFlat(text, name)
  }
  if (extension === '.zip') return await installArchive(bytes)
  throw appError('只能上传 .md 文件或 .zip 压缩包。', 'skill-kind-unknown')
}
