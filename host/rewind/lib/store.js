/**
 * 文件回退用的写前快照。
 *
 * 工具执行前把目标文件的原样存一份（`tools/pre-execute` 里调用），回撤时按
 * "目标序号之后最早那份写前快照"写回：写过的恢复原内容，原本不存在的删掉。
 *
 * 只有工具写过的文件在快照范围内；命令行改动看不到，界面上如实说明。
 * 快照放 `$DSH_HOME/rewind/<sessionId>/`，按序号排序、带大小上限和过期清理。
 * @module yukari-dsh-plugin/rewind/store
 */

import { createHash } from 'node:crypto'
import nodeFs from 'node:fs/promises'
import path from 'node:path'

/** 单份快照的原始字节上限；超出的文件不参与回退。 */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024

/** 快照保留天数。 */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** 每个会话参与回退的最大文件数。 */
export const MAX_ENTRIES = 5000

/** 清理间隔：同一次运行里每个会话十分钟最多扫一次目录。 */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000

/** 路径的稳定短名。 */
const digest = (target) => createHash('sha1').update(target).digest('hex').slice(0, 16)

/** 备份文件名。 */
const entryName = (anchorSeq, target) => `${String(anchorSeq).padStart(8, '0')}-${digest(target)}.json`

/**
 * 建一个快照仓库。
 * @param args - 根目录、文件系统接缝与时钟（测试用）。
 * @returns 捕获、列出、还原、清理。
 */
export function createSnapshotStore({ root, fs = nodeFs, now = () => Date.now() } = {}) {
  const lastPrune = new Map()

  const sessionDir = (sessionId) => path.join(root, sessionId)

  /** 读一个快照文件，坏文件直接跳过。 */
  async function readEntry(file) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      if (typeof parsed?.path !== 'string' || !path.isAbsolute(parsed.path)) return null
      return {
        path: parsed.path,
        anchorSeq: Number(parsed.anchorSeq),
        existed: parsed.existed === true,
        data: typeof parsed.data === 'string' ? parsed.data : null,
      }
    } catch {
      return null
    }
  }

  /**
   * 把一份写前内容存下来。
   * @param args - 会话、锚点序号（执行时的日志长度）、目标路径。
   * @returns 写入结果：`stored`、`missing`（原本不存在）或 `skipped:<原因>`。
   */
  async function capture({ sessionId, anchorSeq, target }) {
    if (typeof sessionId !== 'string' || sessionId === '') return { skipped: 'no-session' }
    if (!Number.isSafeInteger(anchorSeq) || anchorSeq < 0) return { skipped: 'no-anchor' }
    if (typeof target !== 'string' || !path.isAbsolute(target)) return { skipped: 'relative-path' }
    let bytes = null
    try {
      const info = await fs.stat(target)
      if (!info.isFile()) return { skipped: 'not-a-file' }
      if (info.size > MAX_SNAPSHOT_BYTES) return { skipped: 'too-large' }
      bytes = await fs.readFile(target)
    } catch (error) {
      if (error?.code !== 'ENOENT') return { skipped: 'unreadable' }
    }
    const dir = sessionDir(sessionId)
    await fs.mkdir(dir, { recursive: true })
    const entry = {
      path: target,
      anchorSeq,
      existed: bytes !== null,
      data: bytes === null ? null : bytes.toString('base64'),
    }
    const file = path.join(dir, entryName(anchorSeq, target))
    await fs.writeFile(file, JSON.stringify(entry), { mode: 0o600 })
    await prune(sessionId)
    return { stored: true, existed: bytes !== null }
  }

  /** 一个会话的全部快照，按锚点序号升序。 */
  async function entries(sessionId) {
    let names = []
    try {
      names = await fs.readdir(sessionDir(sessionId))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const found = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const entry = await readEntry(path.join(sessionDir(sessionId), name))
      if (entry !== null && Number.isSafeInteger(entry.anchorSeq)) found.push({ ...entry, file: path.join(sessionDir(sessionId), name) })
    }
    found.sort((left, right) => left.anchorSeq - right.anchorSeq)
    return found.slice(0, MAX_ENTRIES)
  }

  /**
   * 算回撤到 `targetSeq` 时要动哪些文件。
   * 每个路径取"锚点序号大于 targetSeq 的最早一份"：那正是它在回撤点上的原样。
   * @returns `{ files: [{ path, action }], skipped }`。
   */
  async function planRestore(sessionId, targetSeq) {
    const all = await entries(sessionId)
    const first = new Map()
    const skipped = []
    for (const entry of all) {
      if (entry.anchorSeq <= targetSeq) continue
      if (!first.has(entry.path)) first.set(entry.path, entry)
      else skipped.push(entry.path)
    }
    const files = []
    for (const [target, entry] of first) {
      files.push({ path: target, action: entry.existed ? 'write' : 'delete' })
    }
    files.sort((left, right) => (left.path < right.path ? -1 : 1))
    return { files, skipped: [...new Set(skipped)] }
  }

  /**
   * 真正写回文件，并丢掉已经越界的快照。
   * @returns `{ restored, deleted, skipped, notes }`。
   */
  async function restore(sessionId, targetSeq) {
    const all = await entries(sessionId)
    const first = new Map()
    for (const entry of all) {
      if (entry.anchorSeq <= targetSeq) continue
      if (!first.has(entry.path)) first.set(entry.path, entry)
    }
    const notes = []
    let restored = 0
    let deleted = 0
    for (const entry of first.values()) {
      try {
        if (entry.existed && entry.data !== null) {
          await fs.mkdir(path.dirname(entry.path), { recursive: true })
          await fs.writeFile(entry.path, Buffer.from(entry.data, 'base64'), { mode: 0o644 })
          restored += 1
        } else if (!entry.existed) {
          await fs.rm(entry.path, { force: true })
          deleted += 1
        }
      } catch (error) {
        notes.push(`还原失败 ${entry.path}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const entry of all) {
      if (entry.anchorSeq > targetSeq) await fs.rm(entry.file, { force: true })
    }
    return { restored, deleted, skipped: 0, notes }
  }

  /** 按天数清理一个会话的快照，十分钟最多扫一次。 */
  async function prune(sessionId) {
    const stamp = now()
    if (stamp - (lastPrune.get(sessionId) ?? 0) < PRUNE_INTERVAL_MS) return
    lastPrune.set(sessionId, stamp)
    const dir = sessionDir(sessionId)
    let names = []
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = path.join(dir, name)
      try {
        const info = await fs.stat(file)
        if (stamp - info.mtimeMs > MAX_AGE_MS) await fs.rm(file, { force: true })
      } catch {
        /* 已经在别处被删掉了 */
      }
    }
  }

  /**
   * 各会话的快照规模，给 markMounted 和面板看。
   * @returns `{ sessions, entries, bytes }`。
   */
  async function stats() {
    let sessions = 0
    let files = 0
    let bytes = 0
    let names = []
    try {
      names = await fs.readdir(root)
    } catch {
      return { sessions, entries: files, bytes }
    }
    for (const name of names) {
      const dir = path.join(root, name)
      let inner = []
      try {
        const info = await fs.stat(dir)
        if (!info.isDirectory()) continue
        inner = await fs.readdir(dir)
      } catch {
        continue
      }
      sessions += 1
      for (const file of inner) {
        if (!file.endsWith('.json')) continue
        files += 1
        try {
          bytes += (await fs.stat(path.join(dir, file))).size
        } catch {
          /* 统计不到就算了 */
        }
      }
    }
    return { sessions, entries: files, bytes }
  }

  return { capture, entries, planRestore, restore, stats }
}
