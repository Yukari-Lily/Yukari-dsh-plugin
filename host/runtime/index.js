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
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { markMounted } from '../shared/mounted.js'
import { NpmRunner, locateRunningPackage } from './lib/npm.js'
import { canExecve, planRestart, scheduleRestart } from './lib/restart.js'
import { compare, normalizeChannel, pickLatest } from './lib/versions.js'
import { guardRoute, readJsonBody, sendJson, messageOf } from '../shared/http.js'

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

/** Last journal line, when the file exists and is small. */
function readLastRestart(file) {
  try {
    const text = readFileSync(file, 'utf8')
    if (text.length > 256 * 1024) return null
    const lines = text.trim().split('\n')
    const last = lines[lines.length - 1]
    return last === undefined || last === '' ? null : JSON.parse(last)
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
  const channel = normalizeChannel(config.channel) ?? normalizeChannel(process.env.DSH_CHANNEL) ?? 'rc'
  const restartMode = String(config.restartMode ?? 'auto')
  const restartCommand = String(config.restartCommand ?? '')
  const restartDelayMs = Number.isFinite(Number(config.restartDelayMs)) ? Number(config.restartDelayMs) : 800
  const npm = new NpmRunner({ registry: config.registry, cacheDir: config.cacheDir })

  /** Latest reading of the copy on disk; `null` until something asked for it. */
  let installed = { value: running?.version ?? null, at: 0, error: null }
  /** Outcome of the last channel check. */
  let update = { latest: null, checkedAt: null, error: null }
  /** What the panel shows under "recent activity". */
  let lastAction = null
  /** Name of the operation holding the lock, or null. */
  let busy = null
  /** Set while a restart is scheduled but has not fired yet. */
  let restartPending = false

/** What the lock holder is doing, in the panel's words. */
const BUSY_LABELS = { check: '检查更新', update: '安装更新' }

  /** Run one operation under the single-operation lock. */
  async function exclusive(name, work) {
    if (busy !== null) throw new Error(`正在${BUSY_LABELS[busy] ?? busy}，等它跑完再试`)
    busy = name
    try {
      return await work()
    } finally {
      busy = null
    }
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
        dir: running?.dir ?? null,
        pid: process.pid,
        node: process.version,
        profile: process.env.DSH_PROFILE ?? null,
        channel,
        startedAt: new Date(startedAt).toISOString(),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        uptime: duration((Date.now() - startedAt) / 1000),
        hostname: hostname(),
        docker: existsSync('/.dockerenv'),
        execve: canExecve,
      },
      disk: {
        version: disk.value,
        stale: disk.value !== null && current !== null && compare(disk.value, current) !== 0,
        readAt: disk.at === 0 ? null : new Date(disk.at).toISOString(),
        error: disk.error,
      },
      update: {
        latest,
        checkedAt: update.checkedAt,
        error: update.error,
        available:
          latest !== null && current !== null ? compare(latest, current) > 0 : latest !== null && current === null,
      },
      npm: { registry: String(config.registry ?? '').trim() || 'default', cacheDir: npm.cacheDir },
      restart: {
        mode: restartMode,
        strategy: plan.strategy,
        reason: plan.reason,
        command: restartCommand === '' ? null : restartCommand,
        delayMs: restartDelayMs,
        pending: restartPending,
        last: readLastRestart(journalFile),
      },
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
        const latest = pickLatest(versions, channel)
        update = { latest: latest ?? null, checkedAt: at, error: latest === undefined ? '没有匹配该通道的版本' : null }
        lastAction = { kind: 'check', at, ok: true, detail: update.latest }
        return { versions: versions.length, latest: update.latest, checkedAt: at }
      } catch (error) {
        update = { ...update, checkedAt: at, error: messageOf(error) }
        lastAction = { kind: 'check', at, ok: false, detail: messageOf(error) }
        throw error
      }
    })
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
        target = pickLatest(versions, channel) ?? null
        if (target === null) throw new Error(`没有匹配通道 ${channel} 的版本`)
        update = { latest: target, checkedAt: at, error: null }
      }
      const before = (await installState(true)).value
      if (before === target) {
        lastAction = { kind: 'update', at, ok: true, detail: `已在 ${target}`, output: '' }
        return { target, installed: before, changed: false, restarted: false }
      }
      const result = await npm.install(target)
      if (result.code !== 0 || result.installed === null) {
        const detail = (result.stderr || result.stdout).trim() || `npm exited ${result.code}`
        lastAction = { kind: 'update', at, ok: false, detail, output: result.stdout }
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
      lastAction = {
        kind: 'update',
        at,
        ok: true,
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
    if (restartPending) throw new Error('重启已经在队列里')
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
      ok: true,
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
