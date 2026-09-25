/**
 * Semantic versions, as far as a release list needs them (licence plan M7):
 * parse, compare, and decide what "latest" means. Pure, so the ordering that
 * decides which build every customer is offered is unit tested.
 *
 * `1.2.3`, `1.2.3-beta.2`, `v1.2` (read as 1.2.0). Build metadata after `+` is
 * ignored, as the spec says. Anything else is not a version.
 */
export interface Version {
  major: number
  minor: number
  patch: number
  prerelease: (string | number)[]
}

const PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(value: string): Version | null {
  const match = PATTERN.exec(value.trim())

  if (!match) {
    return null
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4]
      ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  }
}

/**
 * Negative when `a` is older, positive when newer, zero when equal. A
 * pre-release is older than the release it precedes: `2.0.0-beta.1` < `2.0.0`.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)

  if (!left || !right) {
    return a.localeCompare(b)
  }

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) {
      return left[key] - right[key]
    }
  }

  if (!left.prerelease.length || !right.prerelease.length) {
    return right.prerelease.length - left.prerelease.length
  }

  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const l = left.prerelease[index]
    const r = right.prerelease[index]

    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue

    if (typeof l === 'number' && typeof r === 'number') return l - r
    if (typeof l === 'number') return -1
    if (typeof r === 'number') return 1

    return l < r ? -1 : 1
  }

  return 0
}
