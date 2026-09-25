/**
 * Why a license is not valid (licence plan §5.1).
 *
 * **These strings are public contract.** Every SDK branches on them and they
 * are compiled into software we can never update, so a code is never renamed
 * or reused for a different meaning — only added. Order is the order the
 * checks run in, which is also the order of precedence when more than one
 * applies.
 */
export const LICENSE_REASONS = [
  'invalid_license',
  'product_mismatch',
  'license_revoked',
  'license_suspended',
  'license_expired',
  'subscription_inactive',
  'not_activated',
  'activation_limit_reached',
] as const

export type LicenseReason = (typeof LICENSE_REASONS)[number]
