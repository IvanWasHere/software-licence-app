import type { LicenseReason } from '#licensing/reasons'

/**
 * Whether a license is valid (licence plan §5.1), as a pure function.
 *
 * Validity is **computed on every call**, never stored: a license row only
 * records what somebody decided (suspended, revoked) and the dates it was
 * sold with. Expiry therefore needs no job to flip a flag at midnight, and a
 * renewed subscription is valid the instant its row says so.
 *
 * The checks run in the order of `LICENSE_REASONS` and the first failure
 * wins, so a revoked license that has also expired reports `license_revoked`
 * — the answer that tells the customer what actually happened.
 */

export interface LicenseFacts {
  status: 'active' | 'suspended' | 'revoked'

  /**
   * Epoch milliseconds, compared in JavaScript rather than SQL (CONTRIBUTING,
   * trap 2). `null` is perpetual.
   */
  expiresAtMs: number | null

  productSlug: string

  /**
   * The subscription's status when the license is tied to one; `null` for a
   * license no subscription keeps alive (one-time, manual).
   */
  subscriptionStatus: string | null
}

export interface ValidationRequest {
  productSlug: string
  nowMs: number

  /**
   * `validate` with an instance: is *this installation* activated? Without
   * one, the question is only whether the license itself is good.
   */
  requireActivation?: { isActivated: boolean }
}

export type ValidationResult =
  { valid: true; reason: null } | { valid: false; reason: LicenseReason }

/**
 * Subscription statuses that keep a license alive. `past_due` is included for
 * the reason `Subscription.ENTITLING_STATUSES` gives: a failed card starts
 * dunning, it does not switch a customer's software off mid-week. The dunning
 * job suspends the license when dunning runs out (§5.5).
 */
export const LICENSE_KEEPING_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due'] as const

export function evaluateLicense(
  license: LicenseFacts | null,
  request: ValidationRequest
): ValidationResult {
  if (!license) {
    return invalid('invalid_license')
  }

  if (license.productSlug !== request.productSlug) {
    return invalid('product_mismatch')
  }

  if (license.status === 'revoked') {
    return invalid('license_revoked')
  }

  if (license.status === 'suspended') {
    return invalid('license_suspended')
  }

  if (license.expiresAtMs !== null && license.expiresAtMs <= request.nowMs) {
    return invalid('license_expired')
  }

  if (
    license.subscriptionStatus !== null &&
    !(LICENSE_KEEPING_SUBSCRIPTION_STATUSES as readonly string[]).includes(
      license.subscriptionStatus
    )
  ) {
    return invalid('subscription_inactive')
  }

  if (request.requireActivation && !request.requireActivation.isActivated) {
    return invalid('not_activated')
  }

  return { valid: true, reason: null }
}

function invalid(reason: LicenseReason): ValidationResult {
  return { valid: false, reason }
}
