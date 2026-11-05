import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { resolveInside, safeRelative } from '../host/files/index.js'
import { writeZip } from '../host/files/lib/zip-writer.js'
import { extractZipArchive } from '../host/browser/lib/zip.js'

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yk-files-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
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

test('the archive writer enforces byte limits instead of truncating silently', async (t) => {
  const root = await temporary(t)
  const big = path.join(root, 'big.bin')
  await writeFile(big, Buffer.alloc(2048))
  await assert.rejects(
    writeZip(collector(), [{ name: 'big.bin', path: big }], { maxFileBytes: 1024 }),
    /per-file limit/u,
  )
  await assert.rejects(
    writeZip(collector(), [{ name: 'big.bin', path: big }], { maxTotalBytes: 1024 }),
    /limit/u,
  )
})
