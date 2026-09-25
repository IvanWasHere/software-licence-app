import licensingConfig from '#config/licensing'

/**
 * The hostname an activation is for, from whatever the client sent as its
 * site URL: lower-cased, without a port, a trailing dot or a leading `www.`.
 * `null` when there is nothing hostname-shaped in it — desktop apps
 * legitimately have no site.
 */
export function normalizeHostname(siteUrl: unknown): string | null {
  if (typeof siteUrl !== 'string' || !siteUrl.trim()) {
    return null
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(siteUrl.trim())
    ? siteUrl.trim()
    : `https://${siteUrl.trim()}`

  let hostname: string

  try {
    hostname = new URL(candidate).hostname
  } catch {
    return null
  }

  hostname = hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')

  if (hostname.startsWith('www.')) {
    hostname = hostname.slice(4)
  }

  return hostname || null
}

/**
 * Whether a hostname is a development or staging install (licence plan §5.4).
 */
export function isDevHostname(
  hostname: string | null,
  patterns: readonly string[] = licensingConfig.devHostPatterns
): boolean {
  if (!hostname) {
    return false
  }

  return patterns.some((pattern) => {
    if (pattern.startsWith('*.')) {
      return hostname.endsWith(pattern.slice(1))
    }

    if (pattern.endsWith('.*')) {
      return hostname.startsWith(pattern.slice(0, -1)) && hostname.length > pattern.length - 1
    }

    return hostname === pattern
  })
}
