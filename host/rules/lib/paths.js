/**
 * Fixed locations of the strong-constraint files, and the discovery rules that
 * decide which project a session belongs to.
 *
 * The two constraint files are the component's whole state:
 * - `$DSH_HOME/rules.md` applies to every session;
 * - `<project root>/rules.md` applies to the sessions working under it.
 *
 * @module yukari-dsh-plugin/rules/paths
 */
import fs from 'node:fs'
import path from 'node:path'

/** The constraint file name in both scopes. */
export const RULES_FILE = 'rules.md'

/** The switch file lives next to the harness home, without a plugin prefix. */
export const SETTINGS_FILE = 'rules-settings.json'

/** Directory names that identify a project root while walking up from cwd. */
export const PROJECT_MARKERS = ['.git']

/** How many parent directories the project-root walk visits. */
export const MAX_PROJECT_DEPTH = 12

/** Candidates imported from a workspace, most specific first. */
export const IMPORT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']

/** Candidates imported from the user-global scopes. */
export const GLOBAL_IMPORT_CANDIDATES = ['AGENTS.md']

/** The global constraint file. */
export function globalFile(home) {
  return path.join(home, RULES_FILE)
}

/** The project constraint file for one project root. */
export function workspaceFile(root) {
  return path.join(root, RULES_FILE)
}

/** The switch file. */
export function settingsFile(home) {
  return path.join(home, SETTINGS_FILE)
}

/** Whether `target` is `root` itself or below it (lexical check, no I/O). */
export function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Walk up from a directory to the first ancestor carrying a root marker.
 *
 * The walk is capped: a cwd deep under `/` must not make every assembly inspect
 * the whole filesystem. No marker within the cap means the cwd itself is the
 * project root.
 * @param cwd - absolute session directory.
 * @param markers - names that identify a project root.
 * @returns the project root; always an absolute path.
 */
export function findProjectRoot(cwd, markers = PROJECT_MARKERS) {
  const start = path.resolve(cwd)
  let current = start
  for (let depth = 0; depth < MAX_PROJECT_DEPTH; depth += 1) {
    for (const marker of markers) {
      try {
        if (fs.existsSync(path.join(current, marker))) return current
      } catch {
        /* an unreadable marker is not a match */
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

/** Candidate import files for one scope, in precedence order. */
export function importCandidates(scope, { home, agentsHome, root }) {
  if (scope === 'global') {
    return GLOBAL_IMPORT_CANDIDATES.flatMap((name) => [path.join(home, name), path.join(agentsHome, name)])
  }
  return IMPORT_CANDIDATES.map((name) => path.join(root, name))
}
