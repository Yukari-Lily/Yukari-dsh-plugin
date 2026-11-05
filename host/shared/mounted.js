/**
 * Which Yukari components are mounted right now.
 *
 * Every component row (`yukari-dsh-plugin/<name>`) records itself on the app
 * root while it is active and clears the record when the row is disabled, so
 * the panel can hide a component the user turned off instead of failing with
 * HTTP 404. A later apply (hot reload) replaces the record; a dispose only
 * removes the record it wrote itself.
 * @module yukari-dsh-plugin/shared/mounted
 */

/** Component keys, in panel order. */
export const COMPONENTS = ['chats', 'sites', 'proxy', 'purge', 'browser', 'runtime']

/** Root-level record key. */
const KEY = 'yukari.mounted'

/** The shared record object on the app root. */
function record(ctx) {
  const root = ctx.root ?? ctx
  let value = root[KEY]
  if (value === undefined || value === null || typeof value !== 'object') {
    value = {}
    root[KEY] = value
  }
  return value
}

/**
 * Record one component as mounted for the lifetime of its context.
 * @param ctx - the component row's plugin context.
 * @param name - component key.
 * @param info - optional JSON-safe details the overview shows.
 */
export function markMounted(ctx, name, info = {}) {
  const mounted = record(ctx)
  const entry = { at: new Date().toISOString(), ...info }
  ctx.effect(() => {
    mounted[name] = entry
    return () => {
      if (mounted[name] === entry) delete mounted[name]
    }
  }, `yukari-${name}: mounted`)
}

/**
 * Snapshot of the mounted components.
 * @param ctx - any plugin context of this app.
 * @returns component key → details, or null when the row is off.
 */
export function mountedComponents(ctx) {
  const mounted = record(ctx)
  return Object.fromEntries(COMPONENTS.map((name) => [name, mounted[name] ?? null]))
}
