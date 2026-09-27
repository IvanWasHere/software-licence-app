import logger from '@adonisjs/core/services/logger'

import type { DateTime } from 'luxon'

import Plan from '#models/plan'
import License from '#models/license'
import licenseBilling from '#commerce/license_billing'
import Subscription from '#models/subscription'
import { subscriptionLicenseExpiry } from '#commerce/order_service'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'
import { paymentProvider } from '#billing/provider'
import { PaymentProviderError } from '#billing/contracts'

export interface DriftEntry {
  subscriptionId: number
  providerSubscriptionId: string
  organizationId: number
  field: string
  ours: string | null
  theirs: string | null
}

/**
 * What `reconcile()` may change. Each is a case where leaving the drift alone
 * costs somebody — never one where fixing it could cut a customer short.
 */
type Correction =
  | { kind: 'status'; subscription: Subscription; status: Subscription['status'] }
  | { kind: 'periodEnd'; subscription: Subscription; periodEnd: DateTime }
  | { kind: 'licenseExpiry'; license: License; expiresAt: DateTime }

/**
 * Subscription statuses whose licenses should be alive — the ones a later
 * date is worth adopting for.
 */
const RENEWING = ['trialing', 'active']

export interface ReconciliationReport {
  checked: number
  drifted: DriftEntry[]
  missing: DriftEntry[]
  corrected: number
}

/**
 * Diffs local subscriptions against the provider (plan §7.5).
 *
 * A webhook that is lost — a bad deploy, an endpoint that 500s past Creem's
 * five retries — leaves a customer on the wrong plan silently and forever.
 * This is the sweep that finds that, and it is mostly a *report*. It corrects
 * a status mismatch, whose cost is immediate in both directions, and — since
 * licence plan M8 — a date that would cut a paying customer short: a later
 * period the provider knows about, and a license expiring before its
 * subscription says it should. Nothing it corrects can shorten anything.
 */
export class ReconciliationService {
  /**
   * Look, report, change nothing. What `billing:sync --dry-run` runs, and the
   * half of `reconcile()` that decides.
   */
  async diff(): Promise<ReconciliationReport> {
    const { report } = await this.scan()
    return report
  }

  /**
   * Look, report, and correct what is worth correcting.
   */
  async reconcile(): Promise<ReconciliationReport> {
    const { report, corrections } = await this.scan()

    for (const correction of corrections) {
      if (correction.kind === 'status') {
        await this.correctStatus(correction.subscription, correction.status)
      } else if (correction.kind === 'periodEnd') {
        await this.correctPeriodEnd(correction.subscription, correction.periodEnd)
      } else {
        await licenses.changeExpiry(correction.license, correction.expiresAt, SYSTEM_ACTOR)
      }

      report.corrected++
    }

    return report
  }

  /**
   * The read-only pass.
   *
   * Correcting is deliberately not done inline: a scan that writes as it goes
   * cannot be reused for a dry run without a "don't write" boolean threaded
   * through it, and that boolean is how a dry run eventually writes
   * something.
   */
  private async scan(): Promise<{ report: ReconciliationReport; corrections: Correction[] }> {
    const provider = paymentProvider()

    /**
     * Cancelled and expired subscriptions are skipped: they are terminal, the
     * provider will not change them, and a workspace that cancelled two years
     * ago should not cost a network call every night.
     */
    const subscriptions = await Subscription.query().whereNotIn('status', ['canceled', 'expired'])

    const report: ReconciliationReport = { checked: 0, drifted: [], missing: [], corrected: 0 }
    const corrections: Correction[] = []

    for (const subscription of subscriptions) {
      report.checked++

      let theirs
      try {
        theirs = await provider.getSubscription(subscription.providerSubscriptionId)
      } catch (error) {
        /**
         * A provider having a bad minute is not drift. Logged and skipped, so
         * one unreachable call does not become a page of false alarms.
         */
        logger.warn(
          { err: error, subscriptionId: subscription.id },
          'could not fetch a subscription while reconciling'
        )

        if (error instanceof PaymentProviderError && !error.retryable) {
          throw error
        }

        continue
      }

      const base = {
        subscriptionId: subscription.id,
        providerSubscriptionId: subscription.providerSubscriptionId,
        organizationId: subscription.organizationId,
      }

      if (!theirs) {
        report.missing.push({
          ...base,
          field: 'existence',
          ours: subscription.status,
          theirs: null,
        })
        continue
      }

      if (theirs.status !== subscription.status) {
        report.drifted.push({
          ...base,
          field: 'status',
          ours: subscription.status,
          theirs: theirs.status,
        })

        corrections.push({ kind: 'status', subscription, status: theirs.status })
      }

      const theirPlan = await licenseBilling.planForProduct(theirs.productId)

      if (theirPlan && theirPlan.id !== subscription.planId) {
        report.drifted.push({
          ...base,
          field: 'plan',
          ours: subscription.planId === null ? null : String(subscription.planId),
          theirs: String(theirPlan.id),
        })
      }

      /**
       * Compared as instants, not as strings. A timestamp read back from the
       * database carries a zone offset (`…+00:00`) while one parsed from the
       * provider's payload carries `Z`, so comparing `toISO()` would report
       * drift on every subscription, every night, for ever. Only the *report*
       * renders them as strings.
       */
      const oursEnd = subscription.currentPeriodEnd ?? null
      const theirsEnd = theirs.currentPeriodEnd ?? null

      if (oursEnd?.toMillis() !== theirsEnd?.toMillis()) {
        report.drifted.push({
          ...base,
          field: 'currentPeriodEnd',
          ours: oursEnd?.toUTC().toISO() ?? null,
          theirs: theirsEnd?.toUTC().toISO() ?? null,
        })
      }

      /**
       * A **later** period on a renewing subscription is a renewal whose
       * webhook never arrived (licence plan M8). Left alone, a customer who
       * paid loses their license 30 days after the old period — so this one
       * is corrected. An earlier date is only reported: adopting it would cut
       * somebody short on the provider's word, with nobody looking.
       */
      const renewing = RENEWING.includes(theirs.status)
      const later =
        theirsEnd !== null && (oursEnd === null || theirsEnd.toMillis() > oursEnd.toMillis())

      if (renewing && later) {
        corrections.push({ kind: 'periodEnd', subscription, periodEnd: theirsEnd })
        continue
      }

      if (renewing && subscription.status === theirs.status) {
        await this.checkLicenseExpiry(subscription, base, report, corrections)
      }
    }

    return { report, corrections }
  }

  /**
   * Every license a renewing subscription keeps alive should expire at the
   * period end plus the renewal grace. One that expires **earlier** is cut
   * short and is corrected; one that expires later is reported — staff may
   * have extended it on purpose.
   */
  private async checkLicenseExpiry(
    subscription: Subscription,
    base: Omit<DriftEntry, 'field' | 'ours' | 'theirs'>,
    report: ReconciliationReport,
    corrections: Correction[]
  ): Promise<void> {
    if (!subscription.planId || !subscription.currentPeriodEnd) {
      return
    }

    const plan = await Plan.find(subscription.planId)

    if (!plan) {
      return
    }

    const expected = subscriptionLicenseExpiry(plan, subscription)
    const rows = await License.query()
      .where('subscription_id', subscription.id)
      .where('status', 'active')

    for (const license of rows) {
      const actual = license.expiresAt?.toMillis() ?? null

      if (actual === expected.toMillis()) {
        continue
      }

      report.drifted.push({
        ...base,
        field: `license ${license.publicId} expiresAt`,
        ours: license.expiresAt?.toUTC().toISO() ?? null,
        theirs: expected.toUTC().toISO(),
      })

      if (actual !== null && actual < expected.toMillis()) {
        corrections.push({ kind: 'licenseExpiry', license, expiresAt: expected })
      }
    }
  }

  /**
   * Adopt a later period the provider knows about, and move the licenses it
   * keeps alive with it.
   */
  private async correctPeriodEnd(subscription: Subscription, periodEnd: DateTime): Promise<void> {
    subscription.currentPeriodEnd = periodEnd
    await subscription.save()

    await licenseBilling.syncExpiry(subscription)
  }

  /**
   * Bring the status back in line with the provider, and the licenses it
   * keeps alive with it (licence plan §5.3).
   *
   * The license expiry is re-derived from the period we already have; a
   * later period is corrected separately, above.
   */
  private async correctStatus(
    subscription: Subscription,
    status: Subscription['status']
  ): Promise<void> {
    subscription.status = status
    await subscription.save()

    await licenseBilling.syncExpiry(subscription)
  }
}

export default new ReconciliationService()
