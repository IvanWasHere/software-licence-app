import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

import Plan from '#models/plan'
import License from '#models/license'
import Product from '#models/product'
import Entitlement from '#models/entitlement'
import LicenseEvent from '#models/license_event'
import type Organization from '#models/organization'
import LicenseActivation from '#models/license_activation'
import type { LicenseEventType } from '#licensing/events'
import { generateLicenseKey, licenseKeyHash } from '#licensing/keys'
import { evaluateLicense, type ValidationResult } from '#licensing/validation'
import { resolveEntitlements, type EntitlementValues } from '#catalog/entitlements'

/**
 * Who did something to a license. `client` is the customer's software
 * itself, activating or deactivating through the license API.
 */
export interface LicenseActor {
  type: 'system' | 'staff' | 'user' | 'api_key' | 'client'
  id: number | null
}

export const SYSTEM_ACTOR: LicenseActor = { type: 'system', id: null }

/**
 * A request the licensing rules refuse, with a message fit for a staff screen.
 */
export class LicenseError extends Error {
  constructor(
    message: string,
    readonly field?: string
  ) {
    super(message)
  }
}

export interface IssueInput {
  organization: Organization
  plan: Plan
  source: License['source']
  actor: LicenseActor

  /**
   * Required for a subscription-term plan issued by hand — there is no
   * subscription yet to say when it ends. Overrides the computed end of a
   * fixed-days plan. Ignored for perpetual plans.
   */
  expiresAt?: DateTime | null
  notes?: string | null
  subscriptionId?: number | null

  /**
   * The order item this license fulfils (M4). Unique on `licenses`, which is
   * what makes issuing from a redelivered webhook impossible to do twice.
   */
  orderId?: number | null
  orderItemId?: number | null

  /**
   * Run inside the caller's transaction — order fulfilment issues under a
   * lock on the order row, and the license must commit or roll back with it.
   */
  client?: TransactionClientContract
}

export interface LicenseCheck {
  result: ValidationResult
  license: License | null
  activation: LicenseActivation | null
}

/**
 * Licenses (licence plan §5.2): issuing them, answering whether one is valid,
 * and every state change staff or payments can make.
 *
 * Every change writes a `license_events` row in the same transaction as the
 * change, so the history can never disagree with the row it describes.
 * Staff actions are *additionally* written to the audit log by the
 * controller, which is where "what did this staff member do" is answered.
 */
export class LicenseService {
  /**
   * Issue a license, returning the key — the only moment the whole key exists
   * outside the encrypted column.
   */
  async issue(input: IssueInput): Promise<{ license: License; key: string }> {
    const plan = input.plan
    const product = await Product.findOrFail(plan.productId, { client: input.client })

    if (plan.isArchived) {
      throw new LicenseError('That plan is archived and no longer issues licenses.', 'plan')
    }

    if (product.status === 'retired') {
      throw new LicenseError(`${product.name} is retired and no longer issues licenses.`, 'plan')
    }

    const now = DateTime.utc()
    const expiresAt = this.expiryFor(plan, now, input.expiresAt ?? null)

    if (expiresAt && expiresAt.toMillis() <= now.toMillis()) {
      throw new LicenseError('The expiry date is already in the past.', 'expiresAt')
    }

    const generated = generateLicenseKey(product.keyPrefix)

    const run = async (trx: TransactionClientContract) => {
      const created = await License.create(
        {
          organizationId: input.organization.id,
          productId: product.id,
          planId: plan.id,
          subscriptionId: input.subscriptionId ?? null,
          orderId: input.orderId ?? null,
          orderItemId: input.orderItemId ?? null,
          source: input.source,
          keyHash: generated.hash,
          keyEncrypted: generated.key,
          keySuffix: generated.suffix,
          status: 'active',
          expiresAt,
          updatesUntil:
            plan.licenseTerm === 'perpetual' && plan.updatesDays
              ? now.plus({ days: plan.updatesDays })
              : null,
          supportUntil: null,
          maxActivations: plan.maxActivations ?? null,
          entitlementOverrides: null,
          notes: input.notes ?? null,
        },
        { client: trx }
      )

      await this.record(
        created,
        'issued',
        input.actor,
        {
          plan: plan.slug,
          expiresAt: expiresAt?.toUTC().toISO() ?? null,
          source: input.source,
        },
        trx
      )

      return created
    }

    const license = input.client ? await run(input.client) : await db.transaction(run)

    return { license, key: generated.key }
  }

  /**
   * The single question the license API asks (§5.1): is this key good for
   * this product, and — when an instance is given — is that installation
   * activated? Unknown keys, malformed keys and keys for another product all
   * come back as a reason rather than an exception.
   */
  async check(
    key: unknown,
    productSlug: string,
    instanceId?: string | null
  ): Promise<LicenseCheck> {
    const hash = licenseKeyHash(key)
    const license = hash
      ? await License.query()
          .where('key_hash', hash)
          .preload('product')
          .preload('plan')
          .preload('subscription')
          .first()
      : null

    const activation =
      license && instanceId
        ? await LicenseActivation.query()
            .where('license_id', license.id)
            .where('instance_id', instanceId)
            .whereNull('deactivated_at')
            .first()
        : null

    const result = evaluateLicense(
      license ? license.toFacts(license.product.slug, license.subscription?.status ?? null) : null,
      {
        productSlug,
        nowMs: DateTime.utc().toMillis(),
        requireActivation: instanceId ? { isActivated: Boolean(activation) } : undefined,
      }
    )

    return { result, license, activation }
  }

  /**
   * What the license actually grants, after the plan's values and this
   * license's own overrides (§4).
   */
  async entitlements(license: License): Promise<EntitlementValues> {
    const [definitions, plan] = await Promise.all([
      Entitlement.query().where('product_id', license.productId),
      Plan.findOrFail(license.planId),
    ])

    return resolveEntitlements(
      definitions.map((definition) => definition.toDefinition()),
      plan.entitlements,
      license.entitlementOverrides
    )
  }

  /**
   * Take a license out of service without ending it — a payment problem, a
   * dispute, a suspected leak. Reversible with `resume`.
   */
  async suspend(license: License, reason: string, actor: LicenseActor): Promise<License> {
    if (license.isRevoked) {
      throw new LicenseError('A revoked license cannot be suspended — it is already over.')
    }

    return this.change(license, 'suspended', actor, { reason }, () => {
      license.status = 'suspended'
      license.statusReason = reason
    })
  }

  async resume(license: License, actor: LicenseActor): Promise<License> {
    if (license.isRevoked) {
      throw new LicenseError('A revoked license cannot be resumed. Issue a new one instead.')
    }

    if (!license.isSuspended) {
      throw new LicenseError('That license is not suspended.')
    }

    return this.change(license, 'resumed', actor, {}, () => {
      license.status = 'active'
      license.statusReason = null
    })
  }

  /**
   * Permanent. A refund, a chargeback, a key posted publicly. There is no
   * way back: the honest remedy for a mistaken revoke is a new license, and
   * the history shows both.
   */
  async revoke(license: License, reason: string, actor: LicenseActor): Promise<License> {
    if (license.isRevoked) {
      throw new LicenseError('That license is already revoked.')
    }

    return this.change(license, 'revoked', actor, { reason }, () => {
      license.status = 'revoked'
      license.statusReason = reason
    })
  }

  /**
   * A new key for the same license — what to do when a key leaks but the
   * customer did nothing wrong. Activations are kept, so the customer's
   * sites keep working once they enter the new key; the old key stops
   * matching immediately.
   */
  async reissueKey(
    license: License,
    actor: LicenseActor
  ): Promise<{ license: License; key: string }> {
    if (license.isRevoked) {
      throw new LicenseError('A revoked license cannot get a new key.')
    }

    await license.load('product')
    const generated = generateLicenseKey(license.product.keyPrefix)
    const previousSuffix = license.keySuffix

    await this.change(license, 'key_reissued', actor, { previousSuffix }, () => {
      license.keyHash = generated.hash
      license.keyEncrypted = generated.key
      license.keySuffix = generated.suffix
    })

    return { license, key: generated.key }
  }

  /**
   * Reading the key back. Recorded, because a revealed key is one more place
   * it now exists.
   */
  async revealKey(license: License, actor: LicenseActor): Promise<string> {
    await this.record(license, 'key_revealed', actor, {})
    return license.keyEncrypted
  }

  async changeExpiry(
    license: License,
    expiresAt: DateTime | null,
    actor: LicenseActor
  ): Promise<License> {
    if (license.isRevoked) {
      throw new LicenseError('A revoked license cannot be extended.')
    }

    const before = license.expiresAt?.toUTC().toISO() ?? null

    return this.change(
      license,
      'expiry_changed',
      actor,
      { before, after: expiresAt?.toUTC().toISO() ?? null },
      () => {
        license.expiresAt = expiresAt
      }
    )
  }

  /**
   * Lowering the limit below what is in use deactivates nothing: every
   * current install keeps working and new ones are refused until enough are
   * removed. Switching somebody's live site off is not a side effect a limit
   * change should have.
   */
  async setMaxActivations(
    license: License,
    maxActivations: number | null,
    actor: LicenseActor
  ): Promise<License> {
    return this.change(
      license,
      'activations_limit_changed',
      actor,
      { before: license.maxActivations ?? null, after: maxActivations },
      () => {
        license.maxActivations = maxActivations
      }
    )
  }

  async history(license: License, limit = 100): Promise<LicenseEvent[]> {
    return LicenseEvent.query().where('license_id', license.id).orderBy('id', 'desc').limit(limit)
  }

  async record(
    license: License,
    type: LicenseEventType,
    actor: LicenseActor,
    metadata: Record<string, any>,
    trx?: TransactionClientContract
  ): Promise<LicenseEvent> {
    return LicenseEvent.create(
      {
        licenseId: license.id,
        type,
        actorType: actor.type,
        actorId: actor.id,
        metadata,
        createdAt: DateTime.utc(),
      },
      trx ? { client: trx } : undefined
    )
  }

  /**
   * Apply a mutation and its history entry together.
   */
  private async change(
    license: License,
    type: LicenseEventType,
    actor: LicenseActor,
    metadata: Record<string, any>,
    mutate: () => void
  ): Promise<License> {
    await db.transaction(async (trx) => {
      license.useTransaction(trx)
      mutate()
      await license.save()
      await this.record(license, type, actor, metadata, trx)
    })

    return license
  }

  private expiryFor(plan: Plan, now: DateTime, requested: DateTime | null): DateTime | null {
    switch (plan.licenseTerm) {
      case 'perpetual':
        return null

      case 'fixed_days':
        return requested ?? now.plus({ days: plan.termDays ?? 0 })

      case 'subscription':
        if (!requested) {
          throw new LicenseError(
            'A subscription plan issued by hand needs an expiry date — there is no subscription to say when it ends.',
            'expiresAt'
          )
        }
        return requested
    }
  }
}

export default new LicenseService()
