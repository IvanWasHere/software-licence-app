import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'

import License from '#models/license'
import Product from '#models/product'
import LicenseActivation from '#models/license_activation'
import licensingConfig from '#config/licensing'
import licenses, { type LicenseActor } from '#licensing/license_service'
import { isDevHostname, normalizeHostname } from '#licensing/hostnames'

export interface ActivationInput {
  instanceId: string
  siteUrl?: string | null
  label?: string | null
  ip?: string | null
  userAgent?: string | null
  clientVersion?: string | null
}

export type ActivationResult =
  | { ok: true; activation: LicenseActivation; created: boolean }
  | { ok: false; reason: 'activation_limit_reached'; used: number; max: number }

export interface ActivationUsage {
  used: number
  max: number | null
}

/**
 * Installations using a license (licence plan §5.2).
 *
 * Two rules the database cannot hold, both enforced here under one lock on
 * the license row:
 *
 * 1. **The limit.** A plain count-then-insert lets two installs take the
 *    last slot at once. `forUpdate()` makes that impossible on Postgres and
 *    is a no-op on SQLite, where writes are serialised anyway (CONTRIBUTING,
 *    trap 4) — which is why the lock must be here even though every SQLite
 *    test would pass without it.
 * 2. **One live row per (license, instance).** Would be a partial unique
 *    index, which portability rule 5 forbids.
 *
 * Activating is **idempotent**: the same instance activating twice is one
 * activation, so a client that retries after a timeout cannot use up a
 * customer's slots.
 */
export class ActivationService {
  async activate(
    license: License,
    input: ActivationInput,
    actor: LicenseActor
  ): Promise<ActivationResult> {
    const hostname = normalizeHostname(input.siteUrl)
    const isDev = isDevHostname(hostname)
    const now = DateTime.utc()

    return db.transaction(async (trx) => {
      const locked = await License.query({ client: trx })
        .where('id', license.id)
        .forUpdate()
        .firstOrFail()

      const product = await Product.findOrFail(locked.productId, { client: trx })

      const rows = await LicenseActivation.query({ client: trx })
        .where('license_id', locked.id)
        .orderBy('id', 'asc')

      const live = rows.filter((row) => row.isLive)
      const existing = live.find((row) => row.instanceId === input.instanceId)

      if (existing) {
        existing.useTransaction(trx)
        existing.merge(this.details(input, hostname, isDev))
        existing.lastSeenAt = now
        await existing.save()

        return { ok: true as const, activation: existing, created: false }
      }

      const max = locked.maxActivations ?? null
      const countsAgainstLimit = product.countDevSites || !isDev

      if (countsAgainstLimit && max !== null) {
        const used = this.countUsed(live, product.countDevSites)

        if (used >= max) {
          return { ok: false as const, reason: 'activation_limit_reached' as const, used, max }
        }
      }

      /**
       * An instance that was deactivated and comes back gets its own row
       * again rather than a new one.
       */
      const dormant = rows.find((row) => row.instanceId === input.instanceId && !row.isLive)

      if (dormant) {
        dormant.useTransaction(trx)
        dormant.merge({
          ...this.details(input, hostname, isDev),
          activatedAt: now,
          lastSeenAt: now,
          deactivatedAt: null,
        })
        await dormant.save()

        await licenses.record(locked, 'reactivated', actor, this.summary(dormant), trx)
        return { ok: true as const, activation: dormant, created: true }
      }

      const activation = await LicenseActivation.create(
        {
          licenseId: locked.id,
          instanceId: input.instanceId,
          ...this.details(input, hostname, isDev),
          activatedAt: now,
          lastSeenAt: now,
          deactivatedAt: null,
        },
        { client: trx }
      )

      await licenses.record(locked, 'activated', actor, this.summary(activation), trx)
      return { ok: true as const, activation, created: true }
    })
  }

  /**
   * Deactivate an instance by the id the client holds. `false` when it was
   * not active — deactivating twice is not an error, a client may not know
   * whether its first attempt landed.
   */
  async deactivate(license: License, instanceId: string, actor: LicenseActor): Promise<boolean> {
    const activation = await LicenseActivation.query()
      .where('license_id', license.id)
      .where('instance_id', instanceId)
      .whereNull('deactivated_at')
      .first()

    if (!activation) {
      return false
    }

    await this.deactivateActivation(license, activation, actor)
    return true
  }

  /**
   * Deactivate a specific activation — staff freeing a slot, or a customer
   * removing a site they no longer have from the portal.
   */
  async deactivateActivation(
    license: License,
    activation: LicenseActivation,
    actor: LicenseActor
  ): Promise<void> {
    if (!activation.isLive) {
      return
    }

    await db.transaction(async (trx) => {
      activation.useTransaction(trx)
      activation.deactivatedAt = DateTime.utc()
      await activation.save()

      await licenses.record(license, 'deactivated', actor, this.summary(activation), trx)
    })
  }

  /**
   * Record that an activation is still in use, at most once per
   * `heartbeatThrottleMinutes` — worth knowing, not worth a write per call.
   */
  async touch(activation: LicenseActivation): Promise<void> {
    const threshold = DateTime.utc().minus({ minutes: licensingConfig.heartbeatThrottleMinutes })

    if (activation.lastSeenAt && activation.lastSeenAt.toMillis() > threshold.toMillis()) {
      return
    }

    activation.lastSeenAt = DateTime.utc()
    await activation.save()
  }

  async live(license: License): Promise<LicenseActivation[]> {
    return LicenseActivation.query()
      .where('license_id', license.id)
      .whereNull('deactivated_at')
      .orderBy('activated_at', 'desc')
  }

  async all(license: License): Promise<LicenseActivation[]> {
    return LicenseActivation.query().where('license_id', license.id).orderBy('id', 'desc')
  }

  async find(license: License, publicId: string): Promise<LicenseActivation | null> {
    return LicenseActivation.query()
      .where('license_id', license.id)
      .where('public_id', publicId)
      .first()
  }

  /**
   * Slots in use, by the same rule `activate` enforces — one calculation, so
   * the number on a screen can never disagree with the refusal.
   */
  async usage(license: License): Promise<ActivationUsage> {
    const product = await Product.findOrFail(license.productId)
    const live = await this.live(license)

    return {
      used: this.countUsed(live, product.countDevSites),
      max: license.maxActivations ?? null,
    }
  }

  private countUsed(live: LicenseActivation[], countDevSites: boolean): number {
    return live.filter((row) => countDevSites || !row.isDev).length
  }

  private details(input: ActivationInput, hostname: string | null, isDev: boolean) {
    return {
      hostname,
      siteUrl: input.siteUrl?.slice(0, 1024) ?? null,
      label: input.label?.slice(0, 120) ?? null,
      isDev,
      ip: input.ip?.slice(0, 64) ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      clientVersion: input.clientVersion?.slice(0, 32) ?? null,
    }
  }

  private summary(activation: LicenseActivation) {
    return {
      activation: activation.publicId,
      instanceId: activation.instanceId,
      hostname: activation.hostname,
      isDev: activation.isDev,
    }
  }
}

export default new ActivationService()
