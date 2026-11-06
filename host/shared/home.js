/**
 * The two homes the harness resolves from the process environment.
 *
 * `DSH_HOME` holds this harness's own files; `DSH_AGENTS_HOME` is the shared
 * agents root that every AGENTS.md-compatible tool can read. Both are process
 * policy, not row configuration: a component writes next to the same files the
 * host reads, so it must resolve them the same way.
 * @module yukari-dsh-plugin/shared/home
 */
import os from 'node:os'
import path from 'node:path'

function envHome(name, fallback) {
  const value = process.env[name]
  if (typeof value === 'string' && value.trim() !== '') return path.normalize(value.trim())
  return path.normalize(fallback)
}

/** The harness home (`$DSH_HOME`, default `~/.dsh`). */
export function resolveDshHome() {
  return envHome('DSH_HOME', path.join(os.homedir(), '.dsh'))
}

/** The shared agents root (`$DSH_AGENTS_HOME`, default `~/.agents`). */
export function resolveAgentsHome() {
  return envHome('DSH_AGENTS_HOME', path.join(os.homedir(), '.agents'))
}
