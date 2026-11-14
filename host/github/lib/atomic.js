/**
 * Atomic, owner-only file writes for the Github component.
 *
 * The managed files are read while the rest of the process keeps running: a
 * git command may source the helper script at any moment, and the controller
 * may re-read the token after a save. Truncating those files in place means a
 * crash or a concurrent read sees a half-written token or a shell script that
 * ends mid-line. Write to a same-directory temporary and rename instead, so a
 * reader sees either the old file or the complete new one.
 * @module yukari-dsh-plugin/github/atomic
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Turn any thrown value into a message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Write one file through a unique same-directory temporary and an atomic
 * rename. The random suffix keeps two writers in the same millisecond apart;
 * the pid alone is not unique inside one process.
 * @param file - absolute destination path.
 * @param content - file content.
 * @param mode - permission bits; defaults to 0600.
 */
export async function writeFileAtomic(file, content, mode = 0o600) {
  const directory = path.dirname(file)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    await writeFile(temporary, content, { mode })
    await chmod(temporary, mode)
    await rename(temporary, file)
    await chmod(file, mode)
  } catch (error) {
    throw new Error(`无法写入 ${file}：${messageOf(error)}`)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
