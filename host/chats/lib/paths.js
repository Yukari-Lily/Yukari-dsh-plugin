/**
 * Filesystem address helpers for stored Session artifacts.
 *
 * The JSONL Session backend keeps one directory per Session under
 * `<root>/<project>/<encoded session id>/`. Deleting a chat therefore means
 * removing that directory, and resolving it safely means reproducing the
 * backend's own two encoders instead of trusting a raw id in a path.
 *
 * Both encoders are byte-for-byte the layout the backend documents: safe code
 * units stay literal, everything else becomes `~XXXX`. A Session id that
 * carries `../`, an absolute path, or a NUL cannot escape its project
 * directory after {@link encodeSegment}.
 *
 * @module @local/chat-manager/paths
 */
import path from 'node:path'

/** Project directory the backend uses for Sessions without a working directory. */
export const NO_CWD_PROJECT = '_no-cwd'

/**
 * Encode one raw string as a single safe path segment.
 * @param raw - the string to encode; must be non-empty.
 * @returns the escaped segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Build the human-navigable project directory key for a working directory.
 * @param cwd - the Session's absolute working directory.
 * @returns the project directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Compute one Session's artifact directory from its header fields.
 * @param root - the backend's Session root directory.
 * @param cwd - the Session's working directory, when it had one.
 * @param id - the Session id.
 * @returns the absolute artifact directory.
 */
export function artifactDirectory(root, cwd, id) {
  const project = typeof cwd === 'string' && cwd !== '' ? projectKey(cwd) : NO_CWD_PROJECT
  return path.join(path.resolve(root), project, encodeSegment(id))
}

/**
 * Whether one path sits strictly inside another directory.
 * @param root - container directory.
 * @param candidate - path to test.
 * @returns true when candidate is a descendant of root.
 */
export function isInside(root, candidate) {
  if (typeof root !== 'string' || root === '' || typeof candidate !== 'string' || candidate === '') return false
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Whether one directory is a plausible artifact directory for a Session: a
 * descendant of the root whose own name is the encoded Session id. This is the
 * last gate before a recursive delete.
 * @param root - the backend's Session root directory.
 * @param directory - candidate artifact directory.
 * @param id - the Session id the delete claims to remove.
 * @returns true when the directory may be removed.
 */
export function isArtifactDirectoryOf(root, directory, id) {
  if (!isInside(root, directory)) return false
  let expected
  try {
    expected = encodeSegment(id)
  } catch {
    return false
  }
  return path.basename(path.resolve(directory)) === expected
}
