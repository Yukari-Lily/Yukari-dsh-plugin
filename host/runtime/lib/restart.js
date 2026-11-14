/**
 * Restarting the Host from inside the Host.
 *
 * Three ways out, in order of how much they cost:
 *
 * - `command` — run a shell command that restarts whatever supervises us
 *   (`docker restart dsh` through the socket, a systemd unit, …). Only useful
 *   when the container has that access.
 * - `execve` — replace the process image with a fresh `node <argv>`. Same PID,
 *   same container, same env: for a Docker install this is a real restart
 *   without waiting for the container lifecycle, and it is the default.
 * - `exit` — die and let `restart: unless-stopped` bring the container back.
 *
 * All of them fire after the HTTP response has been written, so the panel sees
 * its acknowledgement before the socket disappears.
 * @module @local/dsh-control/lib/restart
 */
import { spawn } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** The modes the config accepts. */
export const MODES = ['auto', 'execve', 'exit', 'command']

/** Whether this Node can replace its own image. */
export const canExecve = typeof process.execve === 'function'

/**
 * The argv a fresh copy of this process needs: the interpreter, the V8 flags
 * the launcher passed (`--expose-internals` for live reload), then the script
 * and its own arguments.
 * @returns {string[]} argv for `process.execve`.
 */
export function execveArgv() {
  return [process.execPath, ...process.execArgv, ...process.argv.slice(1)]
}

/**
 * Pick the strategy for one restart.
 * @param {{ mode?: string, command?: string }} config - plugin config.
 * @returns {{ strategy: 'command' | 'execve' | 'exit', reason: string, argv?: string[] }} the plan.
 */
export function planRestart(config = {}) {
  const mode = MODES.includes(String(config.mode ?? 'auto')) ? String(config.mode ?? 'auto') : 'auto'
  const command = String(config.command ?? '').trim()
  const argv = execveArgv()
  if (mode === 'command') return { strategy: 'command', reason: 'restartCommand', argv }
  if (mode === 'execve' && canExecve) return { strategy: 'execve', reason: 're-exec in place', argv }
  if (mode === 'exit') return { strategy: 'exit', reason: 'exit and let the supervisor restart', argv }
  if (command !== '') return { strategy: 'command', reason: 'restartCommand', argv }
  if (canExecve) return { strategy: 'execve', reason: 're-exec in place', argv }
  return { strategy: 'exit', reason: 'no execve on this Node; exit and let the supervisor restart', argv }
}

/**
 * Append one line to the restart journal, so a boot that never comes back is
 * still explainable from the volume.
 * @param {string} file - journal path.
 * @param {object} record - what is about to happen.
 */
async function journal(file, record) {
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
  } catch {
    // The journal is a courtesy; never let it block a restart.
  }
}

/**
 * Perform the planned restart after `delayMs`.
 * @param {{ strategy: string, argv?: string[], command?: string }} plan - from {@link planRestart}.
 * @param {{ delayMs?: number, journalFile?: string, reason?: string }} options - timing and bookkeeping.
 * @returns {{ scheduled: true, strategy: string, delayMs: number }} acknowledgement.
 */
export function scheduleRestart(plan, options = {}) {
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, Number(options.delayMs)) : 800
  const fire = () => {
    if (plan.strategy === 'command') {
      const child = spawn('sh', ['-c', plan.command], { detached: true, stdio: 'ignore' })
      child.unref()
      return
    }
    if (plan.strategy === 'execve') {
      try {
        process.execve(process.execPath, plan.argv, { ...process.env })
        return
      } catch {
        // Fall through: an image swap that is refused still has to restart.
      }
    }
    process.exit(0)
  }
  if (options.journalFile !== undefined) {
    void journal(options.journalFile, {
      strategy: plan.strategy,
      reason: options.reason ?? '',
      argv: plan.argv ?? null,
      command: plan.command ?? null,
      pid: process.pid,
    })
  }
  setTimeout(fire, delayMs)
  return { scheduled: true, strategy: plan.strategy, delayMs }
}
