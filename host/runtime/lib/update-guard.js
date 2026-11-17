/**
 * 插件自更新的跨进程锁。
 *
 * 更新本身交给官方 Plugin Manager，回滚也由它负责；这个模块只剩一件事：
 * 同一台机器可能有多个 Host 进程（不同端口/不同 profile 指向同一目录），
 * 进程内的锁管不到它们，这里再加一个 `$DSH_HOME` 下的文件锁；陈旧或损坏的锁
 * 保留并明确报错，不冒险自动接管。
 * @module yukari-dsh-plugin/runtime/update-guard
 */
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 * 同一个目录被两个 Host 进程同时更新时，后一个会看到前一个的锁文件并直接
 * 409。陈旧或损坏的锁也保留并报告位置：自动删除无法与新锁发布形成原子操作，
 * 两个进程可能互相删除对方的新锁，因此这里选择失败关闭而不是自动接管。
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
  // 先在临时文件写完整内容，再用硬链接原子发布。直接创建 owner.json 会让
  // 另一个进程在写入窗口读到空文件，并把仍在运行的持锁者误判为陈旧锁。
  const temporary = path.join(directory, `.${process.pid}-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify({ pid, at: now() }), { flag: 'wx', mode: 0o600 })
    linkSync(temporary, file)
    return () => rmSync(file, { force: true })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const holder = holderOf(file)
    const detail = holder !== null && alive(holder.pid)
      ? `另一个 Harness 进程（pid ${holder.pid}）正在更新插件，请等它完成`
      : `更新锁已陈旧或损坏（${file}）。为避免并发更新，未自动删除；确认没有更新正在执行后，删除该文件再试`
    const busy = new Error(detail)
    busy.status = 409
    throw busy
  } finally {
    rmSync(temporary, { force: true })
  }
}
