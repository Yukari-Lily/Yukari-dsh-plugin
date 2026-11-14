/**
 * One process-wide lock for the operations that rewrite the installation.
 *
 * The main row updates the plugin through pnpm inside the profile; the runtime
 * row installs the harness through npm. They touch different packages, but both
 * change what the next restart loads, so one lock is the only order that holds:
 * whichever starts first wins, the other sees the holder's label and refuses
 * with 409 instead of interleaving two installers on the same node_modules.
 * @module yukari-dsh-plugin/shared/busy
 */

/** What the holder is doing, or null when the lock is free. */
let holder = null

/** Label of the operation holding the lock, or null when idle. */
export function busyLabel() {
  return holder
}

/**
 * Run `work` while no other install-changing operation runs.
 * @param label - what this holder is doing, shown to the user.
 * @param work - the operation.
 * @returns whatever `work` returns.
 */
export async function runExclusive(label, work) {
  const current = holder
  if (current !== null) {
    const error = new Error(`正在${current}，请等待完成后再试`)
    error.status = 409
    error.appCode = 'busy'
    throw error
  }
  holder = label
  try {
    return await work()
  } finally {
    holder = null
  }
}
