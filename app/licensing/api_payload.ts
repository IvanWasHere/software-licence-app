import { DateTime } from 'luxon'

import type Product from '#models/product'
import type License from '#models/license'
import type LicenseActivation from '#models/license_activation'
import signer, { type SignedEnvelope } from '#licensing/signer'
import type { ActivationUsage } from '#licensing/activation_service'

/**
 * The shapes the public license API answers with (licence plan §6).
 *
 * Every field is named here explicitly, as in the org API's transformers, so
 * adding a column can never widen what leaves the process — and every
 * timestamp is `toUTC().toISO()`, so one field never comes out as both `Z`
 * and `+00:00`.
 */

export interface ClientPolicy {
  validation_interval_hours: number
  offline_grace_days: number
}

/**
 * What an SDK is told when it has no product to read the policy from — an
 * unknown slug. Conservative on purpose.
 */
const DEFAULT_POLICY: ClientPolicy = { validation_interval_hours: 24, offline_grace_days: 7 }

export function policyFor(product: Product | null): ClientPolicy {
  return product
    ? {
        validation_interval_hours: product.validationIntervalHours,
        offline_grace_days: product.offlineGraceDays,
      }
    : DEFAULT_POLICY
}

export function licenseSummary(license: License, usage: ActivationUsage) {
  return {
    id: license.publicId,
    status: license.status,
    type: license.plan.licenseTerm,
    expires_at: iso(license.expiresAt),
    updates_until: iso(license.updatesUntil),
    product: license.product.slug,
    plan: license.plan.slug,
    key_suffix: license.keySuffix,
    activations: { used: usage.used, max: usage.max },
  }
}

export function activationSummary(activation: LicenseActivation) {
  return {
    id: activation.publicId,
    instance_id: activation.instanceId,
    hostname: activation.hostname,
    is_dev: activation.isDev,
    activated_at: iso(activation.activatedAt),
  }
}

/**
 * The fields every license API answer carries, whatever the endpoint.
 *
 * `product`, `instance_id` and `nonce` are echoed **inside** the signed
 * payload so a signed answer is bound to the question: a "valid" for one
 * product, one installation or one request cannot be replayed as the answer
 * to another.
 */
export function envelope(input: {
  requestId: string
  product: string
  instanceId?: string | null
  nonce?: string | null
}) {
  return {
    product: input.product,
    instance_id: input.instanceId ?? null,
    nonce: input.nonce ?? null,
    checked_at: iso(DateTime.utc()),
    request_id: input.requestId,
  }
}

/**
 * The payload, plus the same payload signed (licence plan §5.2). Clients
 * trust only `signed.payload` after verifying it; the plain fields are there
 * for curl and for reading logs.
 */
export function withSignature<T extends Record<string, unknown>>(
  payload: T
): T & { signed: SignedEnvelope } {
  return { ...payload, signed: signer.sign(payload) }
}

function iso(value: DateTime | null | undefined): string | null {
  return value ? value.toUTC().toISO() : null
}
