/**
 * Clean-up that goes beyond the chat log itself: files a chat created, and a
 * whole workspace directory.
 *
 * Both are destructive, so every candidate passes several independent gates
 * before anything is unlinked:
 *
 * - generated files come only from `tool/call` events whose tool reported
 *   creating a new file (`write` answering "Created file", or
 *   `str_replace_editor` with `command: create`, which refuses to overwrite);
 *   shell commands are not tracked;
 * - the file must still be a regular file inside the chat's working directory
 *   (or a registered workspace), outside DSH_HOME, and — when the filesystem
 *   records it — born after the chat started;
 * - a workspace directory is only removed when it is a registered workspace
 *   or the working directory of a chat being deleted, and never when it is or
 *   contains a system directory, the home directory, or DSH_HOME.
 * @module @local/chat-manager/cleanup
 */
import nodeFs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { isInside } from './paths.js'

/** Directories that are never removed, nor anything containing them. */
const SYSTEM_DIRS = [
  '/bin', '/boot', '/data', '/dev', '/etc', '/home', '/lib', '/lib64', '/media', '/mnt', '/opt',
  '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var',
]

/** DSH_HOME of this process. */
function dshHome() {
  const value = process.env.DSH_HOME
  return path.resolve(typeof value === 'string' && value !== '' ? value : path.join(os.homedir(), '.dsh'))
}

/**
 * Why a directory must not be removed recursively, or null when it may be.
 * @param directory - candidate directory.
 * @param extraProtected - more directories to keep (e.g. the session root).
 */
export function unsafeDirectoryReason(directory, extraProtected = []) {
  if (typeof directory !== 'string' || directory.trim() === '') return 'empty path'
  const resolved = path.resolve(directory)
  if (resolved === path.parse(resolved).root) return 'filesystem root'
  const keep = [...SYSTEM_DIRS, os.homedir(), dshHome(), ...extraProtected]
    .filter((entry) => typeof entry === 'string' && entry !== '')
    .map((entry) => path.resolve(entry))
  for (const entry of keep) {
    if (resolved === entry) return `protected directory ${entry}`
    if (isInside(resolved, entry)) return `contains protected directory ${entry}`
  }
  if (isInside(dshHome(), resolved)) return 'inside DSH_HOME'
  return null
}

/* ------------------------------------------------------------ event reading */

/** Read every event of one stored chat through the persistence backend. */
async function eventsFromPersistence(persistence, id) {
  if (persistence === undefined || typeof persistence.open !== 'function') return null
  let handle = null
  try {
    handle = await persistence.open(id, 'read')
    const result = await handle.read()
    return Array.isArray(result?.events) ? result.events : null
  } catch {
    return null
  } finally {
    try {
      await handle?.close?.()
    } catch {
      // closing a read handle cannot lose data
    }
  }
}

/** Fallback: decode the newest log file in an artifact directory directly. */
async function eventsFromDirectory(directory, fs) {
  let names = []
  try {
    names = await fs.readdir(directory)
  } catch {
    return []
  }
  const generation = (name) => Number(/session(?:\.v(\d+))?\.jsonl/.exec(name)?.[1] ?? 0)
  const logs = names.filter((name) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name)).sort((a, b) => generation(b) - generation(a))
  for (const name of logs) {
    try {
      let bytes = await fs.readFile(path.join(directory, name))
      if (name.endsWith('.zstd')) {
        if (typeof zlib.zstdDecompressSync !== 'function') continue
        bytes = zlib.zstdDecompressSync(bytes)
      }
      const events = []
      for (const line of bytes.toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          events.push(JSON.parse(line))
        } catch {
          // a torn final line
        }
      }
      return events
    } catch {
      // try an older generation
    }
  }
  return []
}

/** Plain text of one tool result message, whatever its content shape. */
function resultText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('\n')
  }
  return ''
}

/** The tool call id a result message answers. */
function resultCallId(message) {
  if (message === null || typeof message !== 'object') return null
  for (const key of ['toolCallId', 'callId', 'tool_call_id', 'toolUseId', 'id']) {
    if (typeof message[key] === 'string' && message[key] !== '') return message[key]
  }
  return null
}

/**
 * Paths of files one chat created through file tools, in the order created.
 * @param events - the chat's logical event stream.
 * @param cwd - the chat's starting working directory.
 * @returns absolute paths.
 */
export function createdFilesFromEvents(events, cwd) {
  const calls = new Map()
  const results = new Map()
  let directory = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  for (const event of events ?? []) {
    const type = event?.type
    const data = event?.data
    if (data === null || typeof data !== 'object') continue
    if (type === 'working-directory/change') {
      const next = [data.cwd, data.path, data.to, data.directory].find((value) => typeof value === 'string' && value !== '')
      if (next !== undefined) directory = next
      continue
    }
    if (type === 'tool/call' && typeof data.callId === 'string') {
      let args = data.arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          args = null
        }
      }
      calls.set(data.callId, { name: String(data.name ?? ''), args, cwd: directory })
      continue
    }
    if (type === 'tool/result') {
      const id = resultCallId(data.message)
      if (id !== null) results.set(id, { text: resultText(data.message), isError: data.message?.isError === true || data.error !== undefined })
    }
  }

  const created = []
  for (const [id, call] of calls) {
    const args = call.args
    if (args === null || typeof args !== 'object') continue
    const result = results.get(id)
    if (result === undefined || result.isError) continue
    let target = null
    if (call.name === 'str_replace_editor' && args.command === 'create') target = args.path
    else if ((call.name === 'write' || call.name === 'Write') && /Created file/i.test(result.text)) target = args.file_path
    if (typeof target !== 'string' || target.trim() === '') continue
    const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(call.cwd, target)
    if (!created.includes(absolute)) created.push(absolute)
  }
  return created
}

/**
 * Remove the files one chat created.
 * @param args - persistence backend, chat header, artifact directory, allowed roots, fs seam.
 * @returns how many files went, and notes for the ones that stayed.
 */
export async function removeCreatedFiles({ persistence, header, directory, roots = [], fs = nodeFs }) {
  const notes = []
  let removed = 0
  const events = (await eventsFromPersistence(persistence, String(header.id))) ?? (directory === null ? [] : await eventsFromDirectory(directory, fs))
  const candidates = createdFilesFromEvents(events, header.cwd)
  const allowed = [header.cwd, ...roots].filter((entry) => typeof entry === 'string' && entry !== '').map((entry) => path.resolve(entry))
  const createdAt = Number(header.createdAt) || 0
  const home = dshHome()
  const emptied = new Set()

  for (const file of candidates) {
    const base = allowed.find((root) => isInside(root, file))
    if (base === undefined || isInside(home, file)) {
      notes.push(`跳过工作区外的文件：${file}`)
      continue
    }
    let info
    try {
      info = await fs.lstat(file)
    } catch {
      continue // already gone
    }
    if (!info.isFile() && !info.isSymbolicLink()) continue
    // A file born before the chat existed was not created by it (rewritten at most).
    const born = Number(info.birthtimeMs) || 0
    if (born > 0 && createdAt > 0 && born < createdAt - 5000) {
      notes.push(`保留会话前已存在的文件：${file}`)
      continue
    }
    try {
      await fs.unlink(file)
      removed += 1
      emptied.add(JSON.stringify([path.dirname(file), base]))
    } catch (error) {
      notes.push(`删除失败 ${file}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Drop directories the deletes left empty, never the base directory itself.
  for (const pair of emptied) {
    let [current, base] = JSON.parse(pair)
    while (isInside(base, current)) {
      try {
        await fs.rmdir(current)
      } catch {
        break // not empty, or already gone
      }
      current = path.dirname(current)
    }
  }
  return { removed, notes }
}

/**
 * Remove a workspace directory, the directory itself included. A mount point
 * (e.g. the `/workspace` volume) cannot be removed from inside the container:
 * its contents are deleted and the empty mount point stays.
 * @param directory - the directory.
 * @param extraProtected - more directories to keep.
 * @param fs - fs seam.
 * @returns whether the directory is gone, and a note describing what happened.
 */
export async function removeWorkspaceDirectory(directory, extraProtected = [], fs = nodeFs) {
  const reason = unsafeDirectoryReason(directory, extraProtected)
  if (reason !== null) return { removed: false, note: `未删除工作区目录 ${directory}（${reason}）` }
  const resolved = path.resolve(directory)
  try {
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 2 })
    return { removed: true, note: `已删除工作区目录 ${resolved}` }
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES') {
      // The children went first; only the directory entry itself was refused.
      const left = await fs.readdir(resolved).catch(() => null)
      if (Array.isArray(left) && left.length === 0) {
        return { removed: true, note: `已清空 ${resolved}（它是挂载点，目录本身无法在容器内删除）` }
      }
    }
    return { removed: false, note: `删除工作区目录失败 ${resolved}：${error instanceof Error ? error.message : String(error)}` }
  }
}
