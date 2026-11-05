/**
 * Minimal, dependency-free ZIP extraction for the official Chrome archives.
 *
 * The image ships no `unzip`, no `bsdtar`, and no `busybox`, and an npm
 * extraction package would be a large dependency for one code path. Chrome for
 * Testing only uses stored and deflated entries in a standard (non-Zip64)
 * archive, so a small central-directory reader over Node's built-in zlib is
 * enough — and it keeps automatic installation working on any host.
 *
 * Every entry name is validated before anything is written: absolute paths,
 * `..` segments, and symbolic links are refused, so an archive cannot place a
 * file outside the destination directory.
 * @module @local/browser-control/zip
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, open, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'

/** End-of-central-directory signature. */
const EOCD = 0x06054b50
/** Central-directory file header signature. */
const CENTRAL = 0x02014b50
/** Local file header signature. */
const LOCAL = 0x04034b50

/** Largest comment the EOCD scan tolerates, per the format. */
const MAX_COMMENT = 0xffff

/** True when the archive records a Unix symbolic link. */
function isSymlink(externalAttributes) {
  return ((externalAttributes >>> 16) & 0o170000) === 0o120000
}

/** True when the entry is a directory. */
function isDirectory(name, externalAttributes) {
  return name.endsWith('/') || (externalAttributes >>> 16) & 0o170000 === 0o040000
}

/**
 * Reject any name that could leave the destination directory.
 * @param name - the entry name from the archive.
 * @returns the normalized relative path.
 */
export function safeEntryPath(name) {
  const normalized = String(name).replace(/\\/g, '/')
  if (normalized === '' || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`ZIP entry has an absolute path: ${name}`)
  }
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) throw new Error(`ZIP entry escapes the destination: ${name}`)
  if (parts.length === 0) throw new Error(`ZIP entry has an empty path: ${name}`)
  return parts.join(path.sep)
}

/**
 * Read the central directory of a ZIP file.
 * @param handle - open file handle.
 * @param size - file size in bytes.
 * @returns the entries, in archive order.
 */
export async function readCentralDirectory(handle, size) {
  const tailLength = Math.min(size, MAX_COMMENT + 22)
  const tail = Buffer.alloc(tailLength)
  await handle.read(tail, 0, tailLength, size - tailLength)
  let eocd = -1
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD) {
      eocd = index
      break
    }
  }
  if (eocd === -1) throw new Error('not a ZIP archive: no end-of-central-directory record')
  const count = tail.readUInt16LE(eocd + 10)
  const directorySize = tail.readUInt32LE(eocd + 12)
  const directoryOffset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('Zip64 archives are not supported')
  }
  const directory = Buffer.alloc(directorySize)
  await handle.read(directory, 0, directorySize, directoryOffset)

  const entries = []
  let cursor = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL) {
      throw new Error('damaged ZIP central directory')
    }
    const flags = directory.readUInt16LE(cursor + 8)
    const method = directory.readUInt16LE(cursor + 10)
    const compressedSize = directory.readUInt32LE(cursor + 20)
    const nameLength = directory.readUInt16LE(cursor + 28)
    const extraLength = directory.readUInt16LE(cursor + 30)
    const commentLength = directory.readUInt16LE(cursor + 32)
    const externalAttributes = directory.readUInt32LE(cursor + 38)
    const localOffset = directory.readUInt32LE(cursor + 42)
    const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    entries.push({ name, flags, method, compressedSize, localOffset, externalAttributes })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Stream one entry to disk.
 * @param archive - path of the ZIP file.
 * @param handle - open file handle used for header reads.
 * @param entry - central-directory entry.
 * @param destination - file path to write.
 */
async function writeEntry(archive, handle, entry, destination) {
  const header = Buffer.alloc(30)
  await handle.read(header, 0, 30, entry.localOffset)
  if (header.readUInt32LE(0) !== LOCAL) throw new Error(`damaged ZIP local header for ${entry.name}`)
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  const start = entry.localOffset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (entry.compressedSize === 0) {
    await (await import('node:fs/promises')).writeFile(destination, Buffer.alloc(0), { flag: 'wx', mode: 0o755 })
    return
  }
  const source = createReadStream(archive, { start, end: Math.max(start, end - 1) })
  const sink = createWriteStream(destination, { flags: 'wx', mode: 0o755 })
  if (entry.method === 0) {
    await pipeline(source, sink)
    return
  }
  if (entry.method !== 8) throw new Error(`ZIP entry ${entry.name} uses unsupported compression method ${entry.method}`)
  await pipeline(source, createInflateRaw(), sink)
}

/**
 * Extract a ZIP archive into a directory that must not exist yet.
 * @param archive - path of the archive.
 * @param destination - directory to create.
 */
export async function extractZipArchive(archive, destination) {
  const info = await stat(archive)
  const handle = await open(archive, 'r')
  try {
    const entries = await readCentralDirectory(handle, info.size)
    await mkdir(destination, { recursive: true })
    for (const entry of entries) {
      if (isSymlink(entry.externalAttributes)) throw new Error(`ZIP entry is a symbolic link: ${entry.name}`)
      const relative = safeEntryPath(entry.name)
      const target = path.join(destination, relative)
      if (isDirectory(entry.name, entry.externalAttributes)) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(path.dirname(target), { recursive: true })
      await writeEntry(archive, handle, entry, target)
      if (process.platform !== 'win32') await chmod(target, 0o755).catch(() => {})
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    await handle.close()
  }
}
