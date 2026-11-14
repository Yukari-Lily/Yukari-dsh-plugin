/**
 * Runtime control for a containerised Harness: restart the process, upgrade the
 * npm package it runs from, from a sidebar panel or from the agent.
 *
 * The Host half owns three things and exposes each of them twice — once as a
 * small JSON API the panel calls, once as an agent tool:
 *
 * 1. the version actually running (walked up from the entry script) versus the
 *    version on disk (read from the npm global prefix);
 * 2. the upgrade, `npm i -g @deepseek-ai/dsh@<channel-max>` with a cache under
 *    `DSH_HOME` so root-owned cache directories in the image cannot break it;
 * 3. the restart, which re-execs the process in place so a Docker install comes
 *    back on the same port and follows the same volume.
 *
 * There is no Docker socket in the image, so a restart never asks the daemon to
 * do anything. `restartMode: command` exists for deployments that mount one.
 * @module @local/dsh-control
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { markMounted } from '../shared/mounted.js'
import { NpmRunner, locateRunningPackage } from './lib/npm.js'
import { planRestart, scheduleRestart } from './lib/restart.js'
import { candidatesOf, compare, isVersionText, normalizeChannel, satisfiesRange } from './lib/versions.js'
import { appError, guardRoute, readJsonBody, sendJson, messageOf } from '../shared/http.js'
import { busyLabel, runExclusive } from '../shared/busy.js'

/** JSON API prefix served to the Web panel. */
export const API_PATH = '/dshctl/api'

/** How long a cached "installed on disk" reading stays fresh. */
const INSTALLED_TTL_MS = 30_000

/** Services this plugin needs. */
export const inject = ['tools', 'webServer', 'connection']

/** Turn any thrown value into a message. */
/** Seconds as a compact human duration. */
function duration(seconds) {
  const value = Math.max(0, Math.round(seconds))
  if (value < 60) return `${value}s`
  const minutes = Math.floor(value / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h${minutes % 60 === 0 ? '' : ` ${minutes % 60}m`}`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * 升级前的两个前置条件：装到的位置必须就是正在运行的那份，目标版本要能在
 * 本机 Node 上跑。两条都只在事后才发现——一个装到别处，一个重启后起不来。
 * @param {{ runningDir?: string | null, globalRoot?: string | null, nodeVersion: string, engines?: object | null }} facts - 观测值。
 * @returns {string | null} 拒绝理由；通过时为 null。
 */
export function preflightUpgrade({ runningDir, globalRoot, nodeVersion, engines }) {
  if (typeof runningDir === 'string' && typeof globalRoot === 'string' && globalRoot !== '') {
    const prefix = globalRoot.endsWith(path.sep) ? globalRoot : `${globalRoot}${path.sep}`
    if (!`${runningDir}${path.sep}`.startsWith(prefix)) {
      return `当前运行的是 ${runningDir} 这份副本，不在 npm 全局前缀 ${globalRoot} 内；全局安装不会替换它，请按这份副本的安装方式更新`
    }
  }
  const range = engines?.node
  if (typeof range === 'string' && !satisfiesRange(nodeVersion, range)) {
    return `目标版本要求 Node ${range}，当前是 ${nodeVersion}；重启后会起不来，已取消`
  }
  return null
}

/**
 * 上一次成功安装的记录。`applied` 说明新版本是否真的成了当前运行的版本。
 * @param {string} file - 记录文件。
 * @param {string | undefined} runningVersion - 当前运行版本。
 */
function readLastUpdate(file, runningVersion) {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof record?.to !== 'string' || record.to === '') return null
    return {
      from: typeof record.from === 'string' && record.from !== '' ? record.from : null,
      to: record.to,
      at: typeof record.at === 'string' ? record.at : null,
      applied: runningVersion === undefined ? null : record.to === runningVersion,
    }
  } catch {
    return null
  }
}

/**
 * Register the Host half.
 * @param ctx - plugin context.
 * @param config - channel, registry, restartMode, restartCommand, restartDelayMs.
 */
export function apply(ctx, config = {}) {
  markMounted(ctx, 'runtime')
  const running = locateRunningPackage()
  const startedAt = Date.now()
  const dshHome = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')
  const journalFile = path.join(dshHome, '.dsh-control', 'restarts.jsonl')
  const updateFile = path.join(dshHome, '.dsh-control', 'last-update.json')
  const channel = normalizeChannel(config.channel) ?? normalizeChannel(process.env.DSH_CHANNEL) ?? 'rc'
  const restartMode = String(config.restartMode ?? 'auto')
  const restartCommand = String(config.restartCommand ?? '')
  const restartDelayMs = Number.isFinite(Number(config.restartDelayMs)) ? Number(config.restartDelayMs) : 800
  const npm = new NpmRunner({ registry: config.registry, cacheDir: config.cacheDir })

  /** Latest reading of the copy on disk; `null` until something asked for it. */
  let installed = { value: running?.version ?? null, at: 0, error: null }
  /** Outcome of the last channel check. */
  let update = { latest: null, checkedAt: null }
  /** What the panel shows under "recent activity". */
  let lastAction = null
  /** Name of the operation holding the lock, or null. */
  let busy = null
  /** 上一次安装留在这里；面板据此提示"没生效"并提供回撤。 */
  let lastUpdate = readLastUpdate(updateFile, running?.version)
  /** Set while a restart is scheduled but has not fired yet. */
  let restartPending = false

/** What the lock holder is doing, in the panel's words. */
const BUSY_LABELS = { check: '检查更新', update: '安装更新' }

  /**
   * Run one operation under the single-operation lock.
   *
   * `busy` is only what the panel shows; the ordering that matters is shared
   * with the main row, which installs the plugin into the same profile while
   * this row installs the harness — two installers in one node_modules end with
   * a prefix that neither of them planned.
   */
  async function exclusive(name, work) {
    const label = BUSY_LABELS[name] ?? name
    if (busy !== null) throw new Error(`正在${BUSY_LABELS[busy] ?? busy}，等它跑完再试`)
    return await runExclusive(label, async () => {
      busy = name
      try {
        return await work()
      } finally {
        busy = null
      }
    })
  }

  /** Read the on-disk version, refreshed at most once per TTL. */
  async function installState(force = false) {
    if (!force && Date.now() - installed.at < INSTALLED_TTL_MS) return installed
    try {
      const value = await npm.installedVersion()
      installed = { value, at: Date.now(), error: null }
    } catch (error) {
      installed = { value: null, at: Date.now(), error: messageOf(error) }
    }
    return installed
  }

  /** The plan a restart would use right now. */
  function restartPlan() {
    return planRestart({ mode: restartMode, command: restartCommand })
  }

  /** Everything the panel renders on load. */
  async function snapshot() {
    const disk = await installState()
    const plan = restartPlan()
    const current = running?.version ?? disk.value ?? null
    const latest = update.latest
    return {
      runtime: {
        version: current,
        pid: process.pid,
        node: process.version,
        channel,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        uptime: duration((Date.now() - startedAt) / 1000),
      },
      disk: {
        version: disk.value,
        stale: disk.value !== null && current !== null && compare(disk.value, current) !== 0,
        error: disk.error,
      },
      update: {
        latest,
        checkedAt: update.checkedAt,
        available:
          latest !== null && current !== null ? compare(latest, current) > 0 : latest !== null && current === null,
      },
      restart: {
        mode: restartMode,
        strategy: plan.strategy,
        delayMs: restartDelayMs,
      },
      lastUpdate,
      lastAction,
      busy,
    }
  }

  /** Query the registry and remember the channel maximum. */
  async function check() {
    return await exclusive('check', async () => {
      const at = new Date().toISOString()
      try {
        const versions = await npm.versions()
        const latest = await preferred(candidatesOf(versions, channel))
        update = { latest: latest ?? null, checkedAt: at }
        lastAction = { kind: 'check', at, detail: update.latest }
        return { versions: versions.length, latest: update.latest, checkedAt: at }
      } catch (error) {
        update = { ...update, checkedAt: at }
        lastAction = { kind: 'check', at, detail: messageOf(error) }
        throw error
      }
    })
  }

  /**
   * 自动选版时跳过已废弃的发布：装上只会得到一条警告，还会一直被选回来。
   * 前三名都废弃时仍取最高版，不因此卡住更新。
   * @param {string[]} candidates - 同通道版本，新到旧。
   */
  async function preferred(candidates) {
    if (candidates.length === 0) return undefined
    for (const candidate of candidates.slice(0, 3)) {
      if ((await npm.deprecationOf(candidate)) === null) return candidate
    }
    return candidates[0]
  }

  /**
   * Install a version and optionally schedule the restart that activates it.
   * @param {{ version?: string, restart?: boolean }} request - target version or "newest of the channel".
   */
  async function upgrade(request = {}) {
    return await exclusive('update', async () => {
      const at = new Date().toISOString()
      let target = typeof request.version === 'string' && request.version.trim() !== '' ? request.version.trim() : null
      if (target === null) {
        const versions = await npm.versions()
        target = await preferred(candidatesOf(versions, channel)) ?? null
        if (target === null) throw new Error(`通道 ${channel} 没有匹配的版本`)
        update = { latest: target, checkedAt: at }
      } else {
        // Only an exact published version is installable. A range, tag or path
        // would make npm resolve something else than the version the user read.
        if (!isVersionText(target)) {
          const error = new Error(`版本号格式不正确：${target}`)
          error.status = 400
          error.appCode = 'version-invalid'
          error.params = { version: target }
          throw error
        }
        const versions = await npm.versions()
        if (!versions.includes(target)) {
          const error = new Error(`npm 上没有 ${target} 这个版本`)
          error.status = 400
          error.appCode = 'version-unknown'
          error.params = { version: target }
          throw error
        }
      }
      const before = (await installState(true)).value
      if (before === target) {
        lastAction = { kind: 'update', at, detail: `已在 ${target}`, output: '' }
        return { target, installed: before, changed: false, restarted: false }
      }
      // 装错地方和装到起不来的版本，都只有在重启之后才看得出来；先问清楚。
      const refusal = preflightUpgrade({
        runningDir: running?.dir ?? null,
        globalRoot: await npm.globalRoot(),
        nodeVersion: process.versions.node,
        engines: await npm.enginesOf(target),
      })
      if (refusal !== null) {
        const error = new Error(refusal)
        error.status = 409
        error.appCode = 'upgrade-refused'
        lastAction = { kind: 'update', at, detail: refusal, output: '' }
        throw error
      }
      const result = await npm.install(target)
      if (result.code !== 0 || result.installed === null) {
        const detail = (result.stderr || result.stdout).trim() || `npm exited ${result.code}`
        // 失败也可能改过前缀，缓存不能继续报旧数字。
        await installState(true)
        lastAction = { kind: 'update', at, detail, output: result.stdout }
        throw new Error(detail)
      }
      if (result.installed !== target) {
        await installState(true)
        const detail = `npm 退出码为 0，但磁盘上是 ${result.installed}，不是 ${target}`
        lastAction = { kind: 'update', at, detail, output: result.stdout }
        throw new Error(detail)
      }
      const repair = await npm.repairNativeModules()
      await installState(true)
      let restarted = false
      if (request.restart === true) {
        scheduleRestart(restartPlan(), { delayMs: restartDelayMs, journalFile, reason: `update ${target}` })
        restartPending = true
        restarted = true
      }
      lastUpdate = { from: before ?? null, to: target, at, applied: false }
      try {
        mkdirSync(path.dirname(updateFile), { recursive: true })
        writeFileSync(updateFile, JSON.stringify({ from: before ?? null, to: target, at }))
      } catch {
        // 记录只服务于"回撤"和"没生效"提示，写不下不该让更新失败。
      }
      lastAction = {
        kind: 'update',
        at,
        detail: `${before ?? '未知'} → ${result.installed}${restarted ? ' · 已安排重启' : ''}`,
        output: [result.stdout.trim(), repair ?? ''].filter((part) => part !== '').join('\n').trim(),
      }
      return { target, installed: result.installed, changed: true, restarted, output: lastAction.output }
    })
  }

  /**
   * Schedule a restart.
   * @param {{ dryRun?: boolean, delayMs?: number, reason?: string }} request - plan-only or real.
   */
  async function restart(request = {}) {
    const plan = restartPlan()
    if (request.dryRun === true) return { scheduled: false, dryRun: true, strategy: plan.strategy, reason: plan.reason }
    if (restartPending) throw appError('重启已经在队列里', 'restart-queued')
    // A restart during an install is the failure this lock exists to prevent.
    const holder = busyLabel()
    if (holder !== null) {
      const error = new Error(`正在${holder}，请等待完成后再试`)
      error.status = 409
      throw error
    }
    const delayMs = Number.isFinite(Number(request.delayMs)) && Number(request.delayMs) >= 0
      ? Number(request.delayMs)
      : restartDelayMs
    const ack = scheduleRestart(plan, {
      delayMs,
      journalFile,
      reason: typeof request.reason === 'string' ? request.reason : 'panel',
    })
    restartPending = true
    lastAction = {
      kind: 'restart',
      at: new Date().toISOString(),
      detail: `${plan.strategy} · ${delayMs}ms`,
      output: '',
    }
    return { ...ack, reason: plan.reason }
  }

  ctx.tools.register({
    name: 'dsh_runtime_status',
    description:
      'Report the Harness version that is running, the version installed on disk (they differ right after an upgrade), the release channel, and the restart strategy this deployment would use.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'channel'],
        properties: {
          version: { type: 'string', description: 'Version the running process loaded.' },
          installed: { type: 'string', description: 'Version present in the global npm prefix.' },
          channel: { type: 'string', description: 'Release channel used when picking an upgrade target.' },
          latest: { type: 'string', description: 'Newest version of that channel, when a check has run.' },
          updateAvailable: { type: 'boolean', description: 'Whether latest is newer than the running version.' },
          restartStrategy: { type: 'string', description: 'execve, exit or command.' },
          uptime: { type: 'string', description: 'How long this process has been up.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `${value.version} (channel ${value.channel}, installed ${value.installed ?? '?'}, restart ${value.restartStrategy}, up ${value.uptime})${value.latest === undefined ? '' : ` · latest ${value.latest}`}${value.updateAvailable ? ' · update available' : ''}`,
        },
      ],
    },
    async execute() {
      const state = await snapshot()
      // Only real values: `undefined` is not lossless JSON and the tool layer
      // refuses a payload that carries it.
      const value = {
        version: state.runtime.version ?? '未知',
        channel: state.runtime.channel,
        updateAvailable: state.update.available,
        restartStrategy: state.restart.strategy,
        uptime: state.runtime.uptime,
      }
      if (state.disk.version !== null) value.installed = state.disk.version
      if (state.update.latest !== null) value.latest = state.update.latest
      return value
    },
  })

  ctx.tools.register({
    name: 'dsh_check_update',
    description:
      'Ask npm for every published @deepseek-ai/dsh version and pick the newest one on the deployment channel. Reports whether it is newer than the running version.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['channel', 'current', 'updateAvailable'],
        properties: {
          channel: { type: 'string', description: 'Channel queried.' },
          current: { type: 'string', description: 'Version running now.' },
          latest: { type: 'string', description: 'Newest version on the channel.' },
          updateAvailable: { type: 'boolean', description: 'Whether latest is newer than current.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.updateAvailable
            ? `${value.current} -> ${value.latest} available on ${value.channel}`
            : `${value.current} is the newest on ${value.channel}${value.latest === undefined ? '' : ` (${value.latest})`}`,
        },
      ],
    },
    async execute() {
      const result = await check()
      const current = running?.version ?? (await installState(true)).value ?? '未知'
      const value = {
        channel,
        current,
        updateAvailable: result.latest !== null ? compare(result.latest, current) > 0 : false,
      }
      if (result.latest !== null) value.latest = result.latest
      return value
    },
  })

  ctx.tools.register({
    name: 'dsh_update',
    description:
      'Install a newer @deepseek-ai/dsh globally with npm (default: the newest version on the deployment channel), then optionally restart the process so the new code is loaded. A restart ends the current session and re-execs the Host in place.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { type: 'string', description: 'Exact version to install; omit for the channel maximum.' },
        restart: { type: 'boolean', description: 'Restart immediately after a successful install. Defaults to false.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['installed', 'changed'],
        properties: {
          installed: { type: 'string', description: 'Version now present in the global prefix.' },
          changed: { type: 'boolean', description: 'Whether anything was installed.' },
          restarted: { type: 'boolean', description: 'Whether a restart was scheduled.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.changed
            ? `installed ${value.installed}${value.restarted ? ' · restart scheduled' : ' · restart to activate'}`
            : `${value.installed} was already installed`,
        },
      ],
    },
    async execute(args) {
      const result = await upgrade({ version: args.version, restart: args.restart === true })
      return {
        installed: result.installed ?? '未知',
        changed: result.changed,
        restarted: result.restarted ?? false,
      }
    },
  })

  ctx.tools.register({
    name: 'dsh_restart',
    description:
      'Restart the Harness process. Re-execs it in place when this Node supports it, otherwise exits and lets the container supervisor bring it back. The current session and this tool call stop immediately; the UI reconnects afterwards.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['scheduled', 'strategy'],
        properties: {
          scheduled: { type: 'boolean', description: 'Whether a restart was queued.' },
          strategy: { type: 'string', description: 'execve, exit or command.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `restart scheduled (${value.strategy})` }],
    },
    async execute() {
      const result = await restart({ reason: 'agent tool' })
      return { scheduled: result.scheduled === true, strategy: result.strategy }
    },
  })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: guardRoute(ctx, async (req, res) => {
          const url = new URL(String(req.url), 'http://localhost')
          const action = url.pathname.slice(API_PATH.length).replace(/^\/+|\/+$/g, '')
          
          if (action === '' || action === 'state') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'use GET' })
              return
            }
            sendJson(res, 200, { ok: true, state: await snapshot() })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'use POST' })
            return
          }
          const body = await readJsonBody(req)
          if (action === 'check') {
            const result = await check()
            sendJson(res, 200, { ok: true, ...result, state: await snapshot() })
            return
          }
          if (action === 'update') {
            const result = await upgrade({ version: body.version, restart: body.restart === true })
            sendJson(res, 200, { ok: true, ...result, state: await snapshot() })
            return
          }
          if (action === 'restart') {
            const result = await restart({ dryRun: body.dryRun === true, delayMs: body.delayMs, reason: 'panel' })
            sendJson(res, 202, { ok: true, ...result })
            return
          }
          sendJson(res, 404, { ok: false, error: `unknown action "${action}"` })

        }),
      }),
    `dsh-control: ${API_PATH}/*`,
  )
}
