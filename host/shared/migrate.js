/**
 * One-time moves for state this plugin used to keep under an old name.
 *
 * Components moved their files to plain names (`presets.json`, `github/`) so a
 * `DSH_HOME` listing reads like the rest of the harness. An existing install
 * still has the prefixed copies, and losing them would mean re-entering a
 * GitHub token or a hand-edited prompt, so each component calls this once.
 *
 * The rule is deliberately conservative: never delete, never overwrite. When
 * the new path already exists the old one is left alone; when the move fails
 * the component keeps working from the old path.
 * @module yukari-dsh-plugin/shared/migrate
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * Move `from` to `to` when `to` does not exist yet.
 * @param from - legacy absolute path.
 * @param to - current absolute path.
 * @param options - `fs` seam for tests.
 * @returns `'moved'`, `'copied'`, `'kept'` (nothing to do) or `'failed'`.
 */
export function migratePath(from, to, options = {}) {
  const io = options.fs ?? fs
  if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '' || from === to) return 'kept'
  try {
    if (io.existsSync(to)) return 'kept'
    if (!io.existsSync(from)) return 'kept'
  } catch {
    return 'failed'
  }

  try {
    io.renameSync(from, to)
    return 'moved'
  } catch {
    /* a different filesystem, an open handle, or a read-only parent: try a copy */
  }

  try {
    const info = io.statSync(from)
    io.mkdirSync(path.dirname(to), { recursive: true })
    if (info.isDirectory()) io.cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
    else io.copyFileSync(from, to)
    return 'copied'
  } catch {
    return 'failed'
  }
}

/**
 * The legacy sibling of one current path, derived from its directory.
 * @param current - the path this version uses.
 * @param legacyName - the basename an older version used.
 * @returns the legacy absolute path.
 */
export function legacySibling(current, legacyName) {
  return path.join(path.dirname(current), legacyName)
}
