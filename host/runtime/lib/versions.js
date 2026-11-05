/**
 * Version arithmetic for the release channels.
 *
 * The container's entrypoint picks its upgrade target the same way: filter the
 * published version list by channel, then take the largest semver. Dist-tags are
 * deliberately ignored — "latest" has lagged behind the rc line, so tagging a
 * single tag as the truth loses versions.
 * @module @local/dsh-control/lib/versions
 */

/** Channels the panel offers, most conservative first. */
export const CHANNELS = ['stable', 'rc', 'beta', 'alpha']

/**
 * Split a version into its core numbers and prerelease identifiers.
 * @param {string} version - semver text, build metadata ignored.
 */
function split(version) {
  const [core, ...rest] = String(version).trim().split('+')[0].split('-')
  const numbers = core.split('.').map((part) => Number.parseInt(part, 10))
  return { numbers, prerelease: rest.length === 0 ? undefined : rest.join('-') }
}

/**
 * Compare two semver strings.
 * @param {string} a - left version.
 * @param {string} b - right version.
 * @returns {number} negative, zero or positive.
 */
export function compare(a, b) {
  const left = split(a)
  const right = split(b)
  for (let index = 0; index < 3; index += 1) {
    const x = Number.isFinite(left.numbers[index]) ? left.numbers[index] : 0
    const y = Number.isFinite(right.numbers[index]) ? right.numbers[index] : 0
    if (x !== y) return x - y
  }
  if (left.prerelease === undefined || right.prerelease === undefined) {
    if (left.prerelease === right.prerelease) return 0
    // A release outranks any prerelease of the same core version.
    return left.prerelease === undefined ? 1 : -1
  }
  const x = left.prerelease.split('.')
  const y = right.prerelease.split('.')
  for (let index = 0; index < x.length || index < y.length; index += 1) {
    if (x[index] === undefined) return -1
    if (y[index] === undefined) return 1
    const xNumeric = /^\d+$/.test(x[index])
    const yNumeric = /^\d+$/.test(y[index])
    if (xNumeric && yNumeric) {
      const delta = Number(x[index]) - Number(y[index])
      if (delta !== 0) return delta
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1
    } else if (x[index] !== y[index]) {
      return x[index] < y[index] ? -1 : 1
    }
  }
  return 0
}

/**
 * Whether a version belongs to a channel.
 *
 * Releases belong to every channel; prereleases carry the tag that names the
 * line they came from (`rc`, `beta`, `alpha`).
 * @param {string} version - candidate version.
 * @param {string} channel - channel name.
 */
export function matchChannel(version, channel) {
  const { prerelease } = split(version)
  if (prerelease === undefined) return true
  const tag = prerelease.split('.')[0].toLowerCase()
  switch (String(channel).toLowerCase()) {
    case 'stable':
      return false
    case 'rc':
      return tag === 'rc'
    case 'beta':
      return tag === 'rc' || tag === 'beta'
    case 'alpha':
    case 'all':
      return true
    default:
      return tag === 'rc'
  }
}

/**
 * Largest version of one channel.
 * @param {string[]} versions - every published version.
 * @param {string} channel - channel name.
 * @returns {string | undefined} the newest candidate, or undefined when the channel is empty.
 */
export function pickLatest(versions, channel) {
  if (!Array.isArray(versions)) return undefined
  const candidates = versions.filter((version) => matchChannel(version, channel))
  if (candidates.length === 0) return undefined
  return candidates.reduce((max, version) => (compare(version, max) > 0 ? version : max))
}

/**
 * Normalize whatever a user or a form field supplied.
 * @param {unknown} channel - channel text.
 */
export function normalizeChannel(channel) {
  const value = String(channel ?? '').trim().toLowerCase()
  return CHANNELS.includes(value) ? value : undefined
}
