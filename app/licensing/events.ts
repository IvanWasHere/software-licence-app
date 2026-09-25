/**
 * What can happen to a license (licence plan §4), recorded in
 * `license_events`. Like audit actions, these are read months later and
 * filtered on, so a type is never renamed.
 */
export const LICENSE_EVENT_TYPES = [
  'issued',
  'key_reissued',
  'key_revealed',
  'suspended',
  'resumed',
  'revoked',
  'expiry_changed',
  'activations_limit_changed',
  'activated',
  'reactivated',
  'deactivated',
] as const

export type LicenseEventType = (typeof LICENSE_EVENT_TYPES)[number]
