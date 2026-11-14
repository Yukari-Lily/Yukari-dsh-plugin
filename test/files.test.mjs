import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { resolveInside, safeRelative } from '../host/files/index.js'
import { writeZip } from '../host/shared/zip-writer.js'
import { extractZipArchive } from '../host/shared/zip.js'

const run = promisify(execFile)

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yk-files-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** 环境里有没有 python3：有就拿它的 zipfile 做一次独立实现的交叉校验。 */
async function hasPython() {
  try {
    await run('python3', ['--version'])
    return true
  } catch {
    return false
  }
}

/**
 * 直接读中央目录。
 *
 * 这个 writer 的字段（目录标记、Unix 权限、DOS 时间）不在宿主自己的 reader
 * 覆盖范围内，只能按 ZIP 规范自己解析，否则等于用同一份实现验自己。
 * @param buffer - 完整归档字节。
 * @returns `[{ name, flags, method, time, date, crc, compressedSize, size, attributes }]`。
 */
function centralEntries(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.notEqual(end, -1, 'the archive ends with an end-of-central-directory record')
  const count = buffer.readUInt16LE(end + 10)
  const offset = buffer.readUInt32LE(end + 16)
  const entries = []
  let cursor = offset
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, 'central header signature')
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    entries.push({
      name: buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      flags: buffer.readUInt16LE(cursor + 8),
      method: buffer.readUInt16LE(cursor + 10),
      time: buffer.readUInt16LE(cursor + 12),
      date: buffer.readUInt16LE(cursor + 14),
      crc: buffer.readUInt32LE(cursor + 16),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      size: buffer.readUInt32LE(cursor + 24),
      attributes: buffer.readUInt32LE(cursor + 38),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Collect everything written to a fake response. */
function collector() {
  const chunks = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  stream.result = () => Buffer.concat(chunks)
  return stream
}

test('relative paths cannot climb out of the workspace root', () => {
  assert.equal(safeRelative(''), '')
  assert.equal(safeRelative('./a/b'), 'a/b')
  assert.equal(safeRelative('a/./b/'), 'a/b')
  assert.throws(() => safeRelative('../etc/passwd'), /超出工作区/u)
  assert.throws(() => safeRelative('a/../../b'), /超出工作区/u)
  assert.throws(() => safeRelative('/etc/passwd'), /必须相对于/u)
  assert.throws(() => safeRelative('C:/Windows'), /必须相对于/u)
})

test('resolving a path refuses to follow a symbolic link outside the root', async (t) => {
  const root = await temporary(t)
  await mkdir(path.join(root, 'inside'), { recursive: true })
  await writeFile(path.join(root, 'inside', 'ok.txt'), 'ok')
  assert.equal(await resolveInside(root, 'inside/ok.txt'), path.join(root, 'inside', 'ok.txt'))

  const outside = await temporary(t)
  await writeFile(path.join(outside, 'secret.txt'), 'secret')
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
  await assert.rejects(resolveInside(root, 'leak.txt'), /符号链接指向工作区外/u)

  await assert.rejects(resolveInside(root, 'missing.txt'), /路径不存在/u)
})

test('the archive writer produces a ZIP the reader can unpack, unicode names included', async (t) => {
  const root = await temporary(t)
  await mkdir(path.join(root, 'src', '深'), { recursive: true })
  await writeFile(path.join(root, 'readme.md'), '# hello\n'.repeat(40))
  await writeFile(path.join(root, 'src', 'main.js'), 'console.log(1)\n')
  await writeFile(path.join(root, 'src', '深', '内容.txt'), '中文内容')

  const response = collector()
  const entries = [
    { name: 'readme.md', path: path.join(root, 'readme.md') },
    { name: 'src/main.js', path: path.join(root, 'src', 'main.js') },
    { name: 'src/深/内容.txt', path: path.join(root, 'src', '深', '内容.txt') },
  ]
  const result = await writeZip(response, entries)
  assert.equal(result.files, 3)

  const archive = path.join(root, 'out.zip')
  await writeFile(archive, response.result())
  const unpacked = path.join(root, 'unpacked')
  await extractZipArchive(archive, unpacked)
  assert.equal(await readFile(path.join(unpacked, 'readme.md'), 'utf8'), '# hello\n'.repeat(40))
  assert.equal(await readFile(path.join(unpacked, 'src', 'main.js'), 'utf8'), 'console.log(1)\n')
  assert.equal(await readFile(path.join(unpacked, 'src', '深', '内容.txt'), 'utf8'), '中文内容')
})

test('the archive writer has no per-file cap, only the total and the ZIP32 ceiling', async (t) => {
  const root = await temporary(t)
  const big = path.join(root, 'big.bin')
  await writeFile(big, Buffer.alloc(2048))
  // 单文件大小不再是门槛：只按总量拒绝，免得替操作者决定哪些文件能下载。
  await assert.rejects(
    writeZip(collector(), [{ name: 'big.bin', path: big }], { maxTotalBytes: 1024 }),
    /上限/u,
  )
  assert.equal((await writeZip(collector(), [{ name: 'big.bin', path: big }])).files, 1)
})

test('an entry larger than a ZIP can address is refused before writing', async (t) => {
  const root = await temporary(t)
  const huge = path.join(root, 'huge.bin')
  await writeFile(huge, '')
  // 稀疏文件：只占一个目录项，不真的写 4 GiB。
  await truncate(huge, 0x100000000)
  await assert.rejects(writeZip(collector(), [{ name: 'huge.bin', path: huge }]), /4 GiB/u)
})

test('an empty folder survives the archive as a directory entry', async (t) => {
  const root = await temporary(t)
  const empty = path.join(root, 'empty')
  await mkdir(empty)

  const response = collector()
  // 名字不带结尾斜杠：归档格式要求目录条目自己补上，调用方不必记住这条规则。
  const result = await writeZip(response, [{ name: 'empty', path: empty, directory: true }])
  assert.equal(result.files, 1)

  const entries = centralEntries(response.result())
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'empty/')
  assert.equal(entries[0].method, 0, 'a directory carries no data and is stored')
  assert.equal(entries[0].size, 0)
  assert.equal(entries[0].attributes >>> 16, 0o40755)
  assert.equal(entries[0].attributes & 0x10, 0x10, 'the DOS directory bit is set')

  const archive = path.join(root, 'empty.zip')
  await writeFile(archive, response.result())
  const unpacked = path.join(root, 'unpacked')
  await extractZipArchive(archive, unpacked)
  assert.ok((await stat(path.join(unpacked, 'empty'))).isDirectory(), 'the empty folder is recreated')
})

test('the archive keeps the executable bit and the file mtime', async (t) => {
  const root = await temporary(t)
  const script = path.join(root, 'run.sh')
  await writeFile(script, '#!/bin/sh\necho ok\n')
  await chmod(script, 0o755)
  const plain = path.join(root, 'plain.txt')
  await writeFile(plain, 'plain\n')
  await chmod(plain, 0o644)
  const when = new Date(2024, 4, 6, 9, 30, 14)
  await utimes(script, when, when)

  const response = collector()
  await writeZip(response, [
    { name: 'run.sh', path: script },
    { name: 'plain.txt', path: plain },
  ])

  const [executable, text] = centralEntries(response.result())
  assert.equal(executable.attributes >>> 16, 0o100755)
  assert.equal(text.attributes >>> 16, 0o100644)
  assert.equal(executable.time, (9 << 11) | (30 << 5) | (14 >> 1), 'the DOS time comes from the mtime')
  assert.equal(executable.date, ((2024 - 1980) << 9) | (5 << 5) | 6, 'the DOS date comes from the mtime')
})

test('an independent ZIP implementation accepts the archive', async (t) => {
  if (!(await hasPython())) {
    t.skip('python3 is not available')
    return
  }
  const root = await temporary(t)
  await mkdir(path.join(root, 'empty'))
  await writeFile(path.join(root, 'text.txt'), 'hello\n'.repeat(500))
  await writeFile(path.join(root, 'blob.bin'), Buffer.alloc(4096))

  const response = collector()
  await writeZip(response, [
    { name: 'text.txt', path: path.join(root, 'text.txt') },
    { name: 'empty/', path: path.join(root, 'empty'), directory: true },
    { name: 'blob.bin', path: path.join(root, 'blob.bin') },
  ])

  const archive = path.join(root, 'cross.zip')
  await writeFile(archive, response.result())
  // `-t` 会逐条解压并校验 CRC，用的是与这个 writer 完全无关的实现。
  const { stdout } = await run('python3', ['-m', 'zipfile', '-t', archive])
  assert.match(stdout, /Done testing/u)
})
