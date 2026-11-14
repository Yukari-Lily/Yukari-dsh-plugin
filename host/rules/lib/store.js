/**
 * Reading and writing the constraint files.
 *
 * Reads never throw: a missing, unreadable or non-regular file is simply an
 * absent constraint. Writes are atomic (temporary sibling + rename) and refuse
 * a symbolic-link target, so a save can never land outside the directory the
 * panel named.
 * @module yukari-dsh-plugin/rules/store
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isInside } from './paths.js'

/** How many distinct path/limit reads one cache keeps. */
const CACHE_LIMIT = 512

/**
 * Cut a UTF-8 buffer at the last complete character at or before `maxBytes`.
 * @param buffer - file bytes.
 * @param maxBytes - maximum encoded bytes to keep.
 * @returns the decoded prefix, never a broken character.
 */
export function truncateBufferUtf8(buffer, maxBytes) {
  if (buffer.length <= maxBytes) return buffer.toString('utf8')
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (buffer.readUInt8(end) & 192) === 128) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/** The shape every read returns when the file is absent or unreadable. */
function absentDoc(file) {
  return { path: file, exists: false, text: '', bytes: 0, mtimeMs: 0, truncated: false }
}

/**
 * Read the bytes one doc read needs, together with the stat describing them.
 *
 * The cache cannot trust `mtime`/`ctime` alone: on this deployment's
 * filesystems (overlayfs included) both are truncated to the millisecond, so
 * two same-size saves inside one millisecond keep an identical stat signature
 * and the previous body would be injected until the file changes size. Reading
 * stays bounded by the caller's byte ceiling; the fingerprint hashes these
 * bytes instead of the metadata.
 * @param file - absolute path.
 * @param maxBytes - encoded byte ceiling, or null for the whole file.
 * @returns `{ info, buffer, limit }`, or null when the file cannot be read.
 */
function snapshotOf(file, maxBytes) {
  try {
    const info = fs.statSync(file)
    if (!info.isFile()) return null
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.trunc(maxBytes) : null
    const wanted = limit === null || info.size <= limit + 4 ? info.size : limit + 4
    const buffer = Buffer.allocUnsafe(wanted)
    const handle = fs.openSync(file, 'r')
    let read = 0
    try {
      read = fs.readSync(handle, buffer, 0, wanted, 0)
    } finally {
      fs.closeSync(handle)
    }
    return { info, buffer: buffer.subarray(0, read), limit }
  } catch {
    return null
  }
}

/** Decode one snapshot, cutting on a UTF-8 boundary when the ceiling applies. */
function decodeDoc(file, snapshot) {
  const { info, buffer, limit } = snapshot
  const doc = { path: file, exists: true, text: '', bytes: info.size, mtimeMs: info.mtimeMs, truncated: false }
  if (limit === null) {
    doc.text = buffer.toString('utf8')
    return doc
  }
  doc.text = truncateBufferUtf8(buffer, limit)
  doc.truncated = info.size > limit
  return doc
}

/** Content fingerprint of one snapshot, plus the original size the note reports. */
function fingerprintOf(snapshot) {
  const digest = createHash('sha1').update(snapshot.buffer).digest('base64')
  return `${snapshot.info.size}:${digest}`
}

/** Real path, or null when it does not exist. */
export function realPathOf(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    return null
  }
}

/**
 * Read one constraint file, bounded by `maxBytes` (null reads the whole file).
 * @param file - absolute path.
 * @param maxBytes - encoded byte ceiling, or null for the full file.
 * @returns `{ path, exists, text, bytes, mtimeMs, truncated }`; never throws.
 */
export function readDoc(file, maxBytes = null) {
  const snapshot = snapshotOf(file, maxBytes)
  return snapshot === null ? absentDoc(file) : decodeDoc(file, snapshot)
}

/** Metadata only: no content read, no throw. */
export function inspectDoc(file) {
  const doc = { path: file, exists: false, bytes: 0, mtimeMs: 0 }
  try {
    const info = fs.statSync(file)
    if (!info.isFile()) return doc
    doc.exists = true
    doc.bytes = info.size
    doc.mtimeMs = info.mtimeMs
  } catch {
    /* absent */
  }
  return doc
}

/**
 * A read cache keyed by path and byte limit. A changed content fingerprint
 * re-reads; a missing file is never cached.
 * @param limit - maximum entries kept.
 */
export function createDocCache(limit = CACHE_LIMIT) {
  const entries = new Map()
  return {
    read(file, maxBytes = null) {
      const key = `${file}\u0000${maxBytes ?? ''}`
      const snapshot = snapshotOf(file, maxBytes)
      if (snapshot === null) {
        entries.delete(key)
        return absentDoc(file)
      }
      const signature = fingerprintOf(snapshot)
      const cached = entries.get(key)
      if (cached !== undefined && cached.signature === signature) return cached.doc
      const doc = decodeDoc(file, snapshot)
      if (entries.size >= limit) entries.clear()
      entries.set(key, { signature, doc })
      return doc
    },
    invalidate(file) {
      const prefix = `${file}\u0000`
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key)
    },
  }
}

/**
 * Refuse a target the component must not write through.
 * @param file - absolute file path.
 * @param options.root - when set, the directory the file must stay inside.
 * @param options.ensureDir - create the parent directory when missing.
 */
export function assertWritable(file, { root = null, ensureDir = false } = {}) {
  if (root !== null) {
    let info = null
    try {
      info = fs.statSync(root)
    } catch {
      info = null
    }
    if (info === null || !info.isDirectory()) throw new Error('工作区目录不存在')
  }
  let existing = null
  try {
    existing = fs.lstatSync(file)
  } catch {
    existing = null
  }
  if (existing !== null) {
    if (existing.isSymbolicLink()) throw new Error(`${path.basename(file)} 是符号链接，拒绝覆盖`)
    if (!existing.isFile()) throw new Error(`${path.basename(file)} 不是普通文件`)
    const realFile = realPathOf(file)
    const realRoot = root === null ? null : realPathOf(root)
    if (realRoot !== null && realFile !== null && !isInside(realRoot, realFile)) {
      throw new Error(`${path.basename(file)} 指向工作区外`)
    }
  }
  if (ensureDir) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
    } catch {
      /* the write reports the real failure */
    }
  }
}

/**
 * Write a constraint file atomically.
 * @param file - absolute path.
 * @param text - UTF-8 content.
 */
export function writeDoc(file, text) {
  const directory = path.dirname(file)
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const temporary = path.join(directory, `.${path.basename(file)}.${suffix}.tmp`)
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o644 })
    fs.renameSync(temporary, file)
  } catch (error) {
    try {
      fs.unlinkSync(temporary)
    } catch {
      /* already gone */
    }
    throw error
  }
}

/** Remove a constraint file; a missing file is success. */
export function removeDoc(file) {
  try {
    fs.unlinkSync(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
