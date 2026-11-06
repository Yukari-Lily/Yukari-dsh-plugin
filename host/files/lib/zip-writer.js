/**
 * Streaming ZIP writer for workspace downloads.
 *
 * A workspace download has to be produced without shelling out to `zip` (the
 * image has none) and without buffering gigabytes in memory, so entries are
 * deflated one at a time and written straight to the response.
 * @module @local/files/lib/zip-writer
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { deflateRawSync } from 'node:zlib'

/** CRC-32 lookup table. */
const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** CRC-32 as the ZIP format stores it. */
function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** Local file header. */
function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8')
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0x0800, 6)
  header.writeUInt16LE(entry.method, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0x21, 12)
  header.writeUInt32LE(entry.crc, 14)
  header.writeUInt32LE(entry.compressedSize, 18)
  header.writeUInt32LE(entry.size, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  return { header, name }
}

/** Central directory record. */
function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8')
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(0x031e, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0x0800, 8)
  header.writeUInt16LE(entry.method, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt16LE(0x21, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(entry.compressedSize, 20)
  header.writeUInt32LE(entry.size, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  header.writeUInt32LE(entry.offset, 42)
  return { header, name }
}

/**
 * Write a ZIP archive of the given files to a response stream.
 * @param response - writable HTTP response.
 * @param entries - `{ name, path }`, where `name` is the archive path.
 * @param options - byte limits and an optional abort signal.
 * @returns the number of files and bytes written.
 */
export async function writeZip(response, entries, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? 128 * 1024 * 1024
  const maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024
  const written = []
  let offset = 0
  let total = 0

  // Preflight before the first byte: a limit hit halfway through would already
  // have sent a 200 and a partial archive, which the client cannot tell from a
  // truncated one it should not have received.
  const planned = []
  for (const entry of entries) {
    const info = await stat(entry.path)
    if (!info.isFile()) continue
    if (info.size > maxFileBytes) {
      throw new Error(`${entry.name} is larger than the ${Math.round(maxFileBytes / 1048576)} MB per-file limit`)
    }
    total += info.size
    if (total > maxTotalBytes) {
      throw new Error(`the archive would exceed the ${Math.round(maxTotalBytes / 1048576)} MB limit`)
    }
    planned.push(entry)
  }

  try {
    for (const entry of planned) {
      const chunks = []
      for await (const chunk of createReadStream(entry.path)) chunks.push(chunk)
      const content = Buffer.concat(chunks)
      const compressed = deflateRawSync(content, { level: 6 })
      const useDeflate = compressed.length < content.length
      const payload = useDeflate ? compressed : content
      const record = {
        name: entry.name,
        method: useDeflate ? 8 : 0,
        crc: crc32(content),
        size: content.length,
        compressedSize: payload.length,
        offset,
      }
      const { header, name } = localHeader(record)
      response.write(header)
      response.write(name)
      response.write(payload)
      offset += header.length + name.length + payload.length
      written.push(record)
    }

    const directory = Buffer.concat(written.flatMap((record) => {
      const { header, name } = centralHeader(record)
      return [header, name]
    }))
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(written.length, 8)
    end.writeUInt16LE(written.length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(offset, 16)
    response.write(directory)
    response.write(end)
    return { files: written.length, bytes: total }
  } catch (error) {
    // Bytes are already on the wire, so the failure cannot be reported in-band:
    // drop the connection so the client fails the download instead of keeping a
    // corrupt archive.
    if (typeof response.destroy === 'function') response.destroy(error)
    throw error
  }
}
