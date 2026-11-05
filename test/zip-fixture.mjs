/**
 * Test fixtures: a real, standards-compliant ZIP writer and a `fetch`-shaped
 * response, so extraction and download paths run against actual bytes instead
 * of stubbed seams.
 */
import { deflateRawSync } from 'node:zlib'

const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** CRC-32 as ZIP stores it. */
export function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/**
 * Build a ZIP archive in memory.
 * @param entries - `{ name, data, deflate? }`.
 * @returns the archive bytes.
 */
export function zipBuffer(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data ?? '')
    const method = entry.deflate === false ? 0 : 8
    const body = method === 8 && data.length > 0 ? deflateRawSync(data) : data
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100755 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += 30 + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** A `fetch` response whose body is already a list of chunks. */
export function binaryResponse(buffer, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    body: [Buffer.from(buffer)],
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-length' ? String(buffer.length) : null),
    },
  }
}
