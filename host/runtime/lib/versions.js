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
 * Whether text is a plain version that `npm install pkg@<text>` should accept.
 *
 * Ranges, tags, paths and dist-tag names are not versions: the panel and the
 * agent tool send one exact target, and letting anything else through turns the
 * install into "whatever npm resolves", which is how a plugin update installs a
 * different package than the one it names.
 * @param value - text from a form field or tool argument.
 */
export function isVersionText(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(value ?? '').trim())
}

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
 * 一条比较符是否被 `version` 满足。
 * 只覆盖 npm 上真实见得到的写法：比较符、`^`、`~`、x-range；
 * 解析不出来的写法一律当作满足——这是升级前的安全网，不是许可证解析器。
 * @param {string} version - 待判断版本。
 * @param {string} token - 一个比较符。
 */
function satisfiesComparator(version, token) {
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/u.exec(token)
  if (match === null) return true
  const operator = match[1] ?? '='
  const raw = match[2].trim()
  const parts = raw.split('.')
  if (parts.some((part) => /^[xX*]$/u.test(part))) {
    // x-range：只比已经写出来的数字段。
    const known = parts.map((part) => (/^\d+$/u.test(part) ? Number(part) : null)).filter((value) => value !== null)
    if (known.length === 0) return true
    const target = split(version).numbers
    return known.every((value, index) => target[index] === value)
  }
  const bound = split(raw)
  if (bound.numbers.some((value) => !Number.isFinite(value))) return true
  const floor = `${bound.numbers[0]}.${bound.numbers[1] ?? 0}.${bound.numbers[2] ?? 0}`
  const point = bound.prerelease === undefined ? floor : `${floor}-${bound.prerelease}`
  const delta = compare(version, point)
  switch (operator) {
    case '>': return delta > 0
    case '>=': return delta >= 0
    case '<': return delta < 0
    case '<=': return delta <= 0
    case '^': {
      const [major, minor] = bound.numbers
      const ceiling = major > 0 ? `${major + 1}.0.0` : minor > 0 ? `0.${minor + 1}.0` : `0.0.${(bound.numbers[2] ?? 0) + 1}`
      return delta >= 0 && compare(version, ceiling) < 0
    }
    case '~': {
      const [major, minor] = bound.numbers
      return delta >= 0 && compare(version, `${major}.${(minor ?? 0) + 1}.0`) < 0
    }
    default: return delta === 0
  }
}

/**
 * Whether a version satisfies a semver range such as `>=24.9.0` or `^20 || ^22`.
 * @param {string} version - candidate runtime version.
 * @param {string} range - declared range.
 */
export function satisfiesRange(version, range) {
  const text = String(range ?? '').trim()
  if (text === '') return true
  return text.split('||').some((alternative) => {
    const tokens = alternative.trim().split(/\s+/u).filter((token) => token !== '')
    return tokens.length > 0 && tokens.every((token) => satisfiesComparator(version, token))
  })
}

/**
 * Versions of one channel, newest first. Deprecated releases are still listed;
 * the caller decides whether to skip them.
 * @param {string[]} versions - every published version.
 * @param {string} channel - channel name.
 * @returns {string[]} candidates.
 */
export function candidatesOf(versions, channel) {
  if (!Array.isArray(versions)) return []
  return versions.filter((version) => matchChannel(version, channel)).sort((left, right) => compare(right, left))
}

/**
 * Largest version of one channel.
 * @param {string[]} versions - every published version.
 * @param {string} channel - channel name.
 * @returns {string | undefined} the newest candidate, or undefined when the channel is empty.
 */
export function pickLatest(versions, channel) {
  return candidatesOf(versions, channel)[0]
}

/**
 * Normalize whatever a user or a form field supplied.
 * @param {unknown} channel - channel text.
 */
export function normalizeChannel(channel) {
  const value = String(channel ?? '').trim().toLowerCase()
  return CHANNELS.includes(value) ? value : undefined
}
