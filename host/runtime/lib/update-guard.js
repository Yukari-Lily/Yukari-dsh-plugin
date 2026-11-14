/**
 * 插件自更新的跨进程锁。
 *
 * 更新本身交给官方 Plugin Manager，回滚也由它负责；这个模块只剩一件事：
 * 同一台机器可能有多个 Host 进程（不同端口/不同 profile 指向同一目录），
 * 进程内的锁管不到它们，这里再加一个 `$DSH_HOME` 下的文件锁；持有者进程
 * 已经不存在时按陈旧锁接管。
 * @module yukari-dsh-plugin/runtime/update-guard
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'

/** 进程是否还活着。 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 锁文件里记录的持有者，读不到就当没有。 */
function holderOf(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { pid: Number(parsed?.pid), at: typeof parsed?.at === 'string' ? parsed.at : '' }
  } catch {
    return null
  }
}

/**
 * 取一个跨进程的更新锁。
 *
 * 同一个目录被两个 Host 进程同时更新时，后一个会看到前一个的锁文件；只有
 * 持有者进程确实不在了才接管，否则直接 409 让调用方等。JSON 解析失败或
 * pid 缺失的锁按无效处理——那可能是上次崩溃留下的半截文件。
 * @param home - `$DSH_HOME`。
 * @param options - `pid`、`now`，测试用。
 * @returns 释放函数。
 */
export function acquireUpdateLock(home, options = {}) {
  const pid = options.pid ?? process.pid
  const now = options.now ?? (() => new Date().toISOString())
  const directory = path.join(home, '.update-lock')
  const file = path.join(directory, 'owner.json')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = openSync(file, 'wx', 0o600)
      try {
        writeSync(handle, JSON.stringify({ pid, at: now() }))
      } finally {
        closeSync(handle)
      }
      return () => rmSync(file, { force: true })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const holder = holderOf(file)
      if (holder !== null && alive(holder.pid)) {
        const busy = new Error(`另一个 Harness 进程（pid ${holder.pid}）正在更新插件，请等它完成`)
        busy.status = 409
        throw busy
      }
      // 陈旧锁：持有者已退出，或文件本身就是半截 JSON。
      rmSync(file, { force: true })
    }
  }
  const failed = new Error('无法取得更新锁，请检查 $DSH_HOME 的写权限')
  failed.status = 409
  throw failed
}
