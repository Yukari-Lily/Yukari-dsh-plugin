/**
 * 文件回退用的写前快照与还原事务。
 *
 * 工具执行时把目标文件的原样存一份（`tools/execute` 里、审批与守卫之后调用），
 * 回撤时按"目标序号之后最早那份写前快照"写回：写过的恢复原内容，原本不存在的删掉。
 *
 * 还原是多文件、可能中途失败的写操作，所以这里落一份 journal 和写前救援副本：
 * 任何一步失败都不删快照，调用方可以继续或回滚。真正的写入交给宿主文件系统
 * （`ctx.fs`，原子发布且带沙箱判定），本模块不直接写工作区文件。
 *
 * 只有工具写过的文件在快照范围内；命令行改动看不到，界面上如实说明。
 * @module yukari-dsh-plugin/rewind/store
 */

import { createHash, randomUUID } from 'node:crypto'
import nodeFs from 'node:fs/promises'
import path from 'node:path'
import { assertSessionId, isInside } from './safe-path.js'

/** 单份快照的原始字节上限；超出的文件不参与回退。 */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024

/** 快照保留天数。 */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** 每个会话参与回退的最大文件数。 */
export const MAX_ENTRIES = 5000

/** 清理间隔：同一次运行里每个会话十分钟最多扫一次目录。 */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000

/** 快照文件名：八位锚点序号 + 路径摘要。journal、跳过记录与救援副本都不匹配它。 */
const ENTRY_FILE = /^\d{8}-[0-9a-f]{16}\.json$/

/** 救援副本目录与跳过记录的名字。 */
const RESCUE_DIR = 'rescue'
const SKIP_FILE = 'skipped.jsonl'

/** 路径的稳定短名。 */
const digest = (target) => createHash('sha1').update(target).digest('hex').slice(0, 16)

/** 备份文件名。 */
const entryName = (anchorSeq, target) => `${String(anchorSeq).padStart(8, '0')}-${digest(target)}.json`

/** 还原事务 journal 的文件名。 */
const journalName = (targetSeq) => `restore-${String(targetSeq).padStart(8, '0')}.journal.json`

/** 写一个文件并原子替换目标：先写同目录下的临时名，再 rename。 */
async function writeAtomic(fs, file, text, mode) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temp, text, { mode })
  await fs.rename(temp, file)
}

/**
 * 目标路径的规范形态：存在就 realpath，缺失就对最近的现存祖先 realpath 再拼回尾部。
 * 这样符号链接与 `..` 都在比较前被展开，捕获与还原看到的是同一条路径。
 */
async function canonicalPath(fs, target) {
  const absolute = path.resolve(target)
  try {
    return await fs.realpath(absolute)
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
  }
  const missing = []
  let ancestor = absolute
  while (true) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) return absolute
    missing.unshift(path.basename(ancestor))
    ancestor = parent
    try {
      return path.join(await fs.realpath(ancestor), ...missing)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
    }
  }
}

/** 字节内容是不是可无损往返的 UTF-8 文本（宿主写回接口只接受文本）。 */
function textOf(bytes) {
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

/**
 * 建一个快照仓库。
 * @param args - 根目录、文件系统接缝与时钟（测试用）。
 * @returns 捕获、确认、列出、还原、继续、回滚、清理。
 */
export function createSnapshotStore({ root, fs = nodeFs, now = () => Date.now() } = {}) {
  const lastPrune = new Map()

  const sessionDir = (sessionId) => path.join(root, assertSessionId(sessionId))

  const journalPath = (sessionId, targetSeq) => path.join(sessionDir(sessionId), journalName(targetSeq))

  /** 读一个快照文件，坏文件直接跳过。 */
  async function readEntry(file) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      if (typeof parsed?.path !== 'string' || !path.isAbsolute(parsed.path)) return null
      return {
        path: path.resolve(parsed.path),
        root: typeof parsed.root === 'string' && path.isAbsolute(parsed.root) ? path.resolve(parsed.root) : null,
        anchorSeq: Number(parsed.anchorSeq),
        existed: parsed.existed === true,
        data: typeof parsed.data === 'string' ? parsed.data : null,
      }
    } catch {
      return null
    }
  }

  /**
   * 捕获与还原共用的包含校验：目标必须是工作区内的普通文件，realpath 之后仍在
   * 工作区内。捕获时用它决定"能不能记"，还原时用同一份判断决定"能不能写"。
   * @param target - 绝对路径。
   * @param workspaceRoot - 捕获或还原时的会话工作区。
   * @returns `{ ok, real, exists }` 或 `{ ok:false, reason }`。
   */
  async function inspect(target, workspaceRoot) {
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) return { ok: false, reason: 'no-workspace' }
    const absolute = path.resolve(target)
    // The link check comes first: a symlink that points outside is rejected for
    // being a symlink, and the preview then says "符号链接" instead of the
    // misleading "出了工作区" — the operator has to know which one to fix.
    let info
    try {
      info = await fs.lstat(absolute)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return { ok: false, reason: 'unreadable' }
    }
    if (info?.isSymbolicLink()) return { ok: false, reason: 'symlink' }
    let real
    let realRoot
    try {
      real = await canonicalPath(fs, absolute)
      realRoot = await canonicalPath(fs, workspaceRoot)
    } catch {
      return { ok: false, reason: 'unreadable' }
    }
    if (!isInside(realRoot, real)) return { ok: false, reason: 'outside-workspace' }
    if (info !== undefined && !info.isFile()) return { ok: false, reason: 'not-a-file' }
    return { ok: true, real, exists: info !== undefined }
  }

  /** 记下一条"这个文件没能进快照"的原因，回撤预览要如实说明。 */
  async function recordSkip(sessionId, anchorSeq, target, reason) {
    try {
      const dir = sessionDir(sessionId)
      await fs.mkdir(dir, { recursive: true })
      const line = { anchorSeq, path: path.resolve(target), reason, time: now() }
      await fs.appendFile(path.join(dir, SKIP_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 })
    } catch {
      // 记录失败不能让工具调用失败；捕获回执仍把原因交给调用方。
    }
    return { skipped: reason }
  }

  /**
   * 把一份写前内容存下来。
   * @param args - 会话、锚点序号（执行时的日志长度）、工作区、目标路径。
   * @returns `{ stored: true, existed }` 或 `{ skipped: <原因> }`。
   */
  async function capture({ sessionId, anchorSeq, workspaceRoot, target }) {
    const id = assertSessionId(sessionId)
    if (!Number.isSafeInteger(anchorSeq) || anchorSeq < 0) return { skipped: 'no-anchor' }
    if (typeof target !== 'string' || !path.isAbsolute(target)) return { skipped: 'relative-path' }
    const checked = await inspect(target, workspaceRoot)
    if (!checked.ok) return recordSkip(id, anchorSeq, target, checked.reason)
    let bytes = null
    if (checked.exists) {
      try {
        const info = await fs.stat(target)
        if (info.size > MAX_SNAPSHOT_BYTES) return recordSkip(id, anchorSeq, target, 'too-large')
        bytes = await fs.readFile(target)
      } catch (error) {
        if (error?.code !== 'ENOENT') return recordSkip(id, anchorSeq, target, 'unreadable')
      }
    }
    const dir = sessionDir(id)
    await fs.mkdir(dir, { recursive: true })
    const entry = {
      path: path.resolve(target),
      root: path.resolve(workspaceRoot),
      anchorSeq,
      existed: bytes !== null,
      data: bytes === null ? null : bytes.toString('base64'),
    }
    await writeAtomic(fs, path.join(dir, entryName(anchorSeq, target)), JSON.stringify(entry), 0o600)
    await prune(id)
    return { stored: true, existed: bytes !== null }
  }

  /**
   * 工具执行完之后确认这次捕获是否成立。
   *
   * 记成"原本不存在"的快照，回撤时会删掉目标路径；如果这次调用其实失败了、文件
   * 根本没被创建（例如沙箱在工具体内拒绝），留着它只会在将来误删同名文件。
   * @param args - 会话、锚点序号、这次要确认的目标（只处理原本不存在的）、是否失败。
   */
  async function confirm({ sessionId, anchorSeq, targets, failed }) {
    const id = assertSessionId(sessionId)
    if (failed !== true || !Array.isArray(targets) || targets.length === 0) return { dropped: 0 }
    const dir = sessionDir(id)
    let dropped = 0
    for (const target of targets) {
      if (typeof target !== 'string' || !path.isAbsolute(target)) continue
      let exists = true
      try {
        await fs.lstat(target)
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') exists = false
      }
      if (exists) continue
      await fs.rm(path.join(dir, entryName(anchorSeq, target)), { force: true })
      dropped += 1
    }
    return { dropped }
  }

  /** 一个会话的全部快照，按锚点序号升序。 */
  async function entries(sessionId) {
    const dir = sessionDir(sessionId)
    let names = []
    try {
      names = await fs.readdir(dir)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const found = []
    for (const name of names) {
      if (!ENTRY_FILE.test(name)) continue
      const file = path.join(dir, name)
      const entry = await readEntry(file)
      if (entry !== null && Number.isSafeInteger(entry.anchorSeq)) found.push({ ...entry, file })
    }
    found.sort((left, right) => left.anchorSeq - right.anchorSeq)
    return found.slice(0, MAX_ENTRIES)
  }

  /** 读取记下的跳过原因。 */
  async function skipRecords(sessionId) {
    let text = ''
    try {
      text = await fs.readFile(path.join(sessionDir(sessionId), SKIP_FILE), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const line of text.split('\n')) {
      if (line === '') continue
      try {
        const parsed = JSON.parse(line)
        if (typeof parsed?.path === 'string' && Number.isSafeInteger(parsed.anchorSeq) && typeof parsed.reason === 'string') {
          records.push(parsed)
        }
      } catch {
        // 半行（写到一半被中断）不影响其它记录。
      }
    }
    return records
  }

  /** 回撤点之后每个路径的第一份快照：那正是它在回撤点上的原样。 */
  function firstAfter(all, targetSeq) {
    const first = new Map()
    const duplicates = []
    for (const entry of all) {
      if (entry.anchorSeq <= targetSeq) continue
      if (!first.has(entry.path)) first.set(entry.path, entry)
      else duplicates.push(entry.path)
    }
    return { first, duplicates }
  }

  /**
   * 算回撤到 `targetSeq` 时要动哪些文件。
   * @returns `{ files: [{ path, action }], skipped: [{ path, reason }], duplicates }`。
   */
  async function planRestore(sessionId, targetSeq, { workspaceRoot } = {}) {
    const id = assertSessionId(sessionId)
    const all = await entries(id)
    const { first, duplicates } = firstAfter(all, targetSeq)
    const files = []
    const skipped = []
    for (const [target, entry] of first) {
      const checked = await inspect(target, workspaceRoot ?? entry.root)
      if (!checked.ok) {
        skipped.push({ path: target, reason: checked.reason })
        continue
      }
      if (entry.existed && (entry.data === null || textOf(Buffer.from(entry.data, 'base64')) === null)) {
        skipped.push({ path: target, reason: 'not-text' })
        continue
      }
      files.push({ path: target, action: entry.existed ? 'write' : 'delete' })
    }
    const seen = new Set(files.map((file) => file.path))
    for (const record of await skipRecords(id)) {
      if (record.anchorSeq <= targetSeq) continue
      if (first.has(record.path) || seen.has(record.path)) continue
      seen.add(record.path)
      skipped.push({ path: record.path, reason: record.reason })
    }
    files.sort((left, right) => (left.path < right.path ? -1 : 1))
    return { files, skipped, duplicates: [...new Set(duplicates)] }
  }

  /** 读一份 journal；不存在返回 null。 */
  async function readJournal(sessionId, targetSeq) {
    try {
      const parsed = JSON.parse(await fs.readFile(journalPath(sessionId, targetSeq), 'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return null
      return parsed
    } catch {
      return null
    }
  }

  const writeJournal = (sessionId, journal) =>
    writeAtomic(fs, journalPath(sessionId, journal.targetSeq), JSON.stringify(journal), 0o600)

  /** 救援副本按回撤点分组，互不覆盖。 */
  const rescueDir = (sessionId, targetSeq) => path.join(sessionDir(sessionId), RESCUE_DIR, String(targetSeq).padStart(8, '0'))

  /** 救援副本在快照目录里的相对路径：保留工作区内的目录结构。 */
  function rescueName(target, workspaceRoot) {
    const relative = path.relative(workspaceRoot, target)
    return relative === '' || path.isAbsolute(relative) || relative.startsWith('..') ? digest(target) : relative
  }

  /**
   * 写回之前先把目标当前的内容复制到快照目录。回滚靠它。
   * @returns 相对救援目录的路径，或 null（目标当前不存在/不是普通文件）。
   */
  async function takeRescue(sessionId, targetSeq, item) {
    let info
    try {
      info = await fs.lstat(item.path)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      return null
    }
    if (!info.isFile()) return null
    const bytes = await fs.readFile(item.path)
    const relative = rescueName(item.path, item.root)
    const file = path.join(rescueDir(sessionId, targetSeq), relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeAtomic(fs, file, bytes, 0o600)
    return relative
  }

  /**
   * 执行（或继续）一次还原。
   * @param sessionId - 会话 id。
   * @param targetSeq - 回撤到的序号。
   * @param options - 工作区、宿主写入通道 `{ write, remove }`、取消信号。
   * @returns `{ restored, deleted, skipped, failed, notes, journal }`。
   */
  async function restore(sessionId, targetSeq, { workspaceRoot, io, signal } = {}) {
    const id = assertSessionId(sessionId)
    if (io === undefined || typeof io.write !== 'function' || typeof io.remove !== 'function') {
      throw new Error('宿主文件系统不可用，无法还原文件。')
    }
    const all = await entries(id)
    const { first } = firstAfter(all, targetSeq)
    const items = []
    const skipped = []
    for (const [target, entry] of first) {
      const checked = await inspect(target, workspaceRoot ?? entry.root)
      if (!checked.ok) {
        skipped.push({ path: target, reason: checked.reason })
        continue
      }
      if (entry.existed && (entry.data === null || textOf(Buffer.from(entry.data, 'base64')) === null)) {
        skipped.push({ path: target, reason: 'not-text' })
        continue
      }
      items.push({ path: target, action: entry.existed ? 'write' : 'delete', root: path.resolve(workspaceRoot ?? entry.root) })
    }
    let journal = await readJournal(id, targetSeq)
    if (journal === null && items.length === 0) {
      // 没有要动的文件（这次会话根本没写过文件，或全都被跳过了）：不落 journal。
      // 会话的快照目录只由捕获创建，这里凭空写一份会 ENOENT，把一次本来无事可做的
      // 回撤变成 500。
      return { restored: 0, deleted: 0, skipped, failed: [], notes: [], journal: null }
    }
    if (journal === null) {
      journal = { version: 1, sessionId: id, targetSeq, startedAt: now(), status: 'running', items: items.map(pending) }
    } else {
      journal.items = mergeItems(journal.items, items)
      journal.status = 'running'
    }
    await writeJournal(id, journal)
    const failed = []
    for (const item of journal.items) {
      if (item.status === 'done' || item.status === 'skipped') continue
      try {
        if (typeof item.rescue !== 'string') {
          item.rescue = await takeRescue(id, targetSeq, item)
          await writeJournal(id, journal)
        }
        const entry = first.get(item.path)
        if (item.action === 'write') {
          const bytes = Buffer.from(entry.data, 'base64')
          await io.write(item.path, bytes, signal)
        } else {
          await io.remove(item.path, signal)
        }
        item.status = 'done'
        delete item.reason
      } catch (error) {
        item.status = 'failed'
        item.reason = error instanceof Error ? error.message : String(error)
        failed.push({ path: item.path, reason: item.reason })
      }
      await writeJournal(id, journal)
    }
    const done = journal.items.filter((item) => item.status === 'done')
    const restored = done.filter((item) => item.action === 'write').length
    const deleted = done.filter((item) => item.action === 'delete').length
    if (failed.length > 0) {
      // 失败时快照、救援副本与 journal 全留着，调用方可以继续或回滚。
      journal.status = 'failed'
      journal.updatedAt = now()
      await writeJournal(id, journal)
      return {
        restored,
        deleted,
        skipped,
        failed,
        notes: failed.map((item) => `还原失败 ${item.path}：${item.reason}`),
        journal: journalPath(id, targetSeq),
      }
    }
    journal.status = 'complete'
    journal.updatedAt = now()
    await writeJournal(id, journal)
    for (const entry of all) {
      if (entry.anchorSeq > targetSeq) await fs.rm(entry.file, { force: true })
    }
    await fs.rm(rescueDir(id, targetSeq), { recursive: true, force: true })
    await fs.rm(journalPath(id, targetSeq), { force: true })
    return { restored, deleted, skipped, failed: [], notes: [], journal: null }
  }

  /**
   * 回滚一次失败的还原：把已经写下去的内容换回还原前的样子。
   *
   * 只动有救援副本或确实已完成的条目；失败的条目保持原样，因为它们可能根本没写进去。
   * journal 与快照保留，方便事后核对。
   * @returns `{ reverted, failed }`。
   */
  async function rollback(sessionId, targetSeq, { io, signal } = {}) {
    const id = assertSessionId(sessionId)
    if (io === undefined || typeof io.write !== 'function' || typeof io.remove !== 'function') {
      throw new Error('宿主文件系统不可用，无法回滚。')
    }
    const journal = await readJournal(id, targetSeq)
    if (journal === null) throw new Error('没有可回滚的还原记录。')
    const failed = []
    let reverted = 0
    for (const item of journal.items) {
      if (item.status !== 'done' && item.status !== 'failed') continue
      try {
        if (typeof item.rescue === 'string') {
          const file = path.join(rescueDir(id, targetSeq), item.rescue)
          await io.write(item.path, await fs.readFile(file), signal)
          reverted += 1
        } else if (item.status === 'done' && item.action === 'write') {
          // 还原前这里没有文件：撤掉刚刚写出来的那份。
          await io.remove(item.path, signal)
          reverted += 1
        }
        item.status = 'rolled-back'
        delete item.reason
      } catch (error) {
        item.status = 'failed'
        item.reason = error instanceof Error ? error.message : String(error)
        failed.push({ path: item.path, reason: item.reason })
      }
    }
    journal.status = failed.length === 0 ? 'rolled-back' : 'failed'
    journal.updatedAt = now()
    await writeJournal(id, journal)
    return { reverted, failed }
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
      const file = path.join(dir, name)
      try {
        if (name === RESCUE_DIR) {
          for (const group of await fs.readdir(file)) {
            const groupFile = path.join(file, group)
            const info = await fs.stat(groupFile)
            if (stamp - info.mtimeMs > MAX_AGE_MS) await fs.rm(groupFile, { recursive: true, force: true })
          }
          continue
        }
        if (!name.endsWith('.json') && name !== SKIP_FILE) continue
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
        if (!ENTRY_FILE.test(file)) continue
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

  return { capture, confirm, entries, planRestore, restore, rollback, stats }
}

/** journal 里的新条目。 */
function pending(item) {
  return { path: item.path, action: item.action, root: item.root, rescue: null, status: 'pending' }
}

/**
 * 失败后继续时合并计划：已完成/已回滚的条目按路径沿用，新出现的路径追加为待办。
 * 已经写下的救援副本不能被新一轮覆盖，否则回滚会拿到还原后的内容。
 */
function mergeItems(existing, planned) {
  const byPath = new Map(existing.map((item) => [item.path, item]))
  const merged = []
  for (const item of planned) {
    const previous = byPath.get(item.path)
    merged.push(previous === undefined ? pending(item) : { ...previous, root: item.root, action: item.action })
    byPath.delete(item.path)
  }
  return merged
}
