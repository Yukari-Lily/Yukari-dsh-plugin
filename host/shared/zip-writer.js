/**
 * Streaming ZIP writer for workspace and skill downloads.
 *
 * A download has to be produced without shelling out to `zip` (the image has
 * none) and without buffering gigabytes in memory: each entry is read through a
 * deflate stream and written straight to the response, and every write waits
 * for `drain`, so a slow client never turns into a growing buffer.
 * @module yukari-dsh-plugin/shared/zip-writer
 */
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflateRaw } from 'node:zlib'

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

/** 非 zip64 的 ZIP 字段全是 32 位；更大的归档只能拒绝，不能悄悄截断。 */
const UINT32_MAX = 0xffffffff

/** 本地文件头与中央目录记录的固定长度。 */
const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46

/** 数据描述符：签名 + CRC + 压缩后大小 + 原始大小。 */
const DESCRIPTOR_BYTES = 16

/** 通用标志位：0x0800 表示名字是 UTF-8，0x0008 表示 CRC 与大小写在数据之后。 */
const UTF8_FLAG = 0x0800
const DESCRIPTOR_FLAG = 0x0008

/** 目录条目的 external attributes：高位 Unix 目录 0o40755，低位 DOS 目录位。 */
const DIRECTORY_ATTRIBUTES = ((0o40755 << 16) | 0x10) >>> 0

/** CRC-32 的初始值。 */
const CRC_INITIAL = 0xffffffff

/** 按块更新 CRC-32 的运行值。 */
function crc32Update(value, buffer) {
  let crc = value
  for (const byte of buffer) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc
}

/** CRC-32 的收尾值，即 ZIP 里记录的那个数。 */
function crc32Finish(value) {
  return (value ^ 0xffffffff) >>> 0
}

/**
 * 把文件 mtime 换成 DOS 时间戳。
 *
 * DOS 时间按本地时区记录、秒只有 2 秒精度；早于 1980 年的时间落到格式下限。
 * @param mtimeMs - 毫秒时间戳。
 * @returns `{ time, date }`，两个 16 位字段。
 */
function dosTimestamp(mtimeMs) {
  const moment = new Date(Number.isFinite(mtimeMs) ? mtimeMs : 0)
  const year = moment.getFullYear()
  if (!Number.isFinite(year) || year < 1980) return { time: 0, date: 0x21 }
  return {
    time: (moment.getHours() << 11) | (moment.getMinutes() << 5) | (moment.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((moment.getMonth() + 1) << 5) | moment.getDate(),
  }
}

/** 文件条目的 external attributes：高位是 Unix 权限，可执行位要保留。 */
function fileAttributes(mode) {
  const executable = (mode & 0o111) !== 0
  return ((executable ? 0o100755 : 0o100644) << 16) >>> 0
}

/** Local file header. */
function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8')
  const header = Buffer.alloc(LOCAL_HEADER_BYTES)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(entry.flags, 6)
  header.writeUInt16LE(entry.method, 8)
  header.writeUInt16LE(entry.time, 10)
  header.writeUInt16LE(entry.date, 12)
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
  const header = Buffer.alloc(CENTRAL_HEADER_BYTES)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(0x031e, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(entry.flags, 8)
  header.writeUInt16LE(entry.method, 10)
  header.writeUInt16LE(entry.time, 12)
  header.writeUInt16LE(entry.date, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(entry.compressedSize, 20)
  header.writeUInt32LE(entry.size, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE(entry.attributes, 38)
  header.writeUInt32LE(entry.offset, 42)
  return { header, name }
}

/**
 * 写一块并等待背压。
 *
 * 响应没有人再读时 `drain` 永远不会来，只等它就是挂住处理器；所以同时盯着
 * `close`，连接一断就把等待变成失败，交给调用方销毁上游。
 * @param response - writable HTTP response.
 * @param chunk - bytes to write.
 */
async function writeChunk(response, chunk) {
  if (response.write(chunk)) return
  const controller = new AbortController()
  const onClose = () => controller.abort()
  response.once('close', onClose)
  try {
    await once(response, 'drain', { signal: controller.signal })
  } catch (error) {
    if (response.destroyed) throw new Error('the client closed the connection')
    throw error
  } finally {
    response.off('close', onClose)
  }
}

/**
 * 把压缩后的块写进响应。
 *
 * `callback` 在真正写完（或连接断开）之后才被调用，这就是 pipeline 需要的背压。
 * @param response - writable HTTP response.
 * @param onChunk - 每写出一块时记账。
 * @returns the sink stream.
 */
function responseSink(response, onChunk) {
  return new Writable({
    write(chunk, _encoding, callback) {
      onChunk(chunk)
      writeChunk(response, chunk).then(() => callback(), (error) => callback(error))
    },
  })
}

/**
 * 写入一个文件条目。
 *
 * CRC 与大小在读完之前不可能知道，所以本地头里这三项留 0，由通用标志位
 * 0x0008 指明"数据之后还有描述符"，收尾再补一个数据描述符。这样第一个字节
 * 不必等整个文件读完就能发出去。
 * @param response - writable HTTP response.
 * @param entry - planned entry carrying `info`.
 * @param offset - local header offset.
 * @returns the record for the central directory.
 */
async function writeFileEntry(response, entry, offset) {
  const { time, date } = dosTimestamp(entry.info.mtimeMs)
  const record = {
    name: entry.name,
    flags: UTF8_FLAG | DESCRIPTOR_FLAG,
    method: 8,
    crc: 0,
    size: 0,
    compressedSize: 0,
    time,
    date,
    attributes: fileAttributes(entry.info.mode),
    offset,
  }
  const { header, name } = localHeader(record)
  await writeChunk(response, header)
  await writeChunk(response, name)

  let checksum = CRC_INITIAL
  let size = 0
  let compressedSize = 0
  // CRC 必须按原始字节算：deflate 之后拿到的是压缩输出，所以中间夹一层计数。
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      checksum = crc32Update(checksum, chunk)
      size += chunk.length
      callback(null, chunk)
    },
  })
  const sink = responseSink(response, (chunk) => { compressedSize += chunk.length })
  await pipeline(createReadStream(entry.path), meter, createDeflateRaw({ level: 6 }), sink)

  const descriptor = Buffer.alloc(DESCRIPTOR_BYTES)
  descriptor.writeUInt32LE(0x08074b50, 0)
  descriptor.writeUInt32LE(crc32Finish(checksum), 4)
  descriptor.writeUInt32LE(compressedSize, 8)
  descriptor.writeUInt32LE(size, 12)
  await writeChunk(response, descriptor)

  return {
    ...record,
    crc: crc32Finish(checksum),
    size,
    compressedSize,
    consumed: header.length + name.length + compressedSize + descriptor.length,
  }
}

/**
 * 写入一个目录条目，并保留空目录。
 *
 * 名字必须以 `/` 结尾，否则解压器会把它当成 0 字节文件；external attributes
 * 的高位标 Unix 目录，低位的 0x10 是 DOS 目录属性。
 * @param response - writable HTTP response.
 * @param entry - planned entry carrying `info`.
 * @param offset - local header offset.
 * @returns the record for the central directory.
 */
async function writeDirectoryEntry(response, entry, offset) {
  const { time, date } = dosTimestamp(entry.info.mtimeMs)
  const record = {
    name: entry.name.endsWith('/') ? entry.name : `${entry.name}/`,
    flags: UTF8_FLAG,
    method: 0,
    crc: 0,
    size: 0,
    compressedSize: 0,
    time,
    date,
    attributes: DIRECTORY_ATTRIBUTES,
    offset,
  }
  const { header, name } = localHeader(record)
  await writeChunk(response, header)
  await writeChunk(response, name)
  return { ...record, consumed: header.length + name.length }
}

/**
 * Write a ZIP archive of the given files to a response stream.
 *
 * The only per-entry ceiling is what a non-zip64 archive can address: files are
 * streamed, so a large one costs time, not memory. A fixed per-file cap would
 * only decide for the operator which of their own files are downloadable.
 * @param response - writable HTTP response.
 * @param entries - `{ name, path }`, where `name` is the archive path.
 * @param options - `maxTotalBytes`: the archive ceiling; defaults to the ZIP32 limit.
 * @returns the number of entries and bytes written.
 */
export async function writeZip(response, entries, options = {}) {
  const maxTotalBytes = options.maxTotalBytes ?? UINT32_MAX
  const written = []
  let offset = 0
  let total = 0

  // Preflight before the first byte: a limit hit halfway through would already
  // have sent a 200 and a partial archive, which the client cannot tell from a
  // truncated one it should not have received.
  const planned = []
  for (const entry of entries) {
    const info = await stat(entry.path)
    if (info.isDirectory()) {
      planned.push({ ...entry, info })
      continue
    }
    if (!info.isFile()) continue
    if (info.size > UINT32_MAX) throw new Error(`「${entry.name}」超过 ZIP 单文件 4 GiB 上限`)
    total += info.size
    if (total > maxTotalBytes) throw new Error(`归档将超过 ${Math.round(maxTotalBytes / 1048576)} MB 上限`)
    planned.push({ ...entry, info })
  }
  if (total > UINT32_MAX) throw new Error('归档超过 ZIP 单包 4 GiB 上限，请减少所选文件')

  try {
    for (const entry of planned) {
      if (offset > UINT32_MAX) throw new Error('归档超过 ZIP 单包 4 GiB 上限，请减少所选文件')
      const record = entry.info.isDirectory()
        ? await writeDirectoryEntry(response, entry, offset)
        : await writeFileEntry(response, entry, offset)
      written.push(record)
      offset += record.consumed
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
    await writeChunk(response, directory)
    await writeChunk(response, end)
    return { files: written.length, bytes: total }
  } catch (error) {
    // Bytes are already on the wire, so the failure cannot be reported in-band:
    // drop the connection so the client fails the download instead of keeping a
    // corrupt archive.
    if (typeof response.destroy === 'function') response.destroy()
    throw error
  }
}
