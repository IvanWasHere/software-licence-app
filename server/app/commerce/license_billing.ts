import logger from '@adonisjs/core/services/logger'

import Plan from '#models/plan'
import Order from '#models/order'
import License from '#models/license'
import type Payment from '#models/payment'
import type Subscription from '#models/subscription'
import { subscriptionLicenseExpiry } from '#commerce/order_service'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'

/**
 * What money moving means for licenses (licence plan §5.3, M4) — the part of
 * the webhook handler that is about licenses rather than about the provider.
 *
 * | event                          | effect here                              |
 * |--------------------------------|------------------------------------------|
 * | period renewed / updated       | expiry = period end + renewal grace      |
 * | payment failed (past_due)      | nothing — the expiry is the dunning      |
 * | canceled / expired             | nothing — validation reads the status    |
 * | full refund                    | revoke                                   |
 * | partial refund                 | nothing; staff decide                    |
 * | dispute                        | suspend (reversible, a human decides)    |
 */
export class LicenseBilling {
  /**
   * Move every license a subscription keeps alive to its current period's
   * end plus the grace. Only ever set from the provider's period, so a late
   * event cannot shorten a license a newer one extended: the watermark guard
   * in the handler has already dropped it.
   */
  async syncExpiry(subscription: Subscription): Promise<void> {
    if (!subscription.planId || !subscription.currentPeriodEnd) {
      return
    }

    const plan = await Plan.findOrFail(subscription.planId)
    const expiresAt = subscriptionLicenseExpiry(plan, subscription)

    const rows = await License.query()
      .where('subscription_id', subscription.id)
      .whereNot('status', 'revoked')

    for (const license of rows) {
      if (license.expiresAt?.toMillis() === expiresAt.toMillis()) {
        continue
      }

      await licenses.changeExpiry(license, expiresAt, SYSTEM_ACTOR)
    }
  }

  /**
   * A full refund ends what it paid for. A partial one is recorded and left
   * to staff — "refund the second seat" is not something a webhook can tell
   * apart from "refund half as a goodwill gesture".
   */
  async applyRefund(payment: Payment): Promise<void> {
    const order = await this.orderFor(payment)

    if (order) {
      order.status = payment.status === 'refunded' ? 'refunded' : 'partially_refunded'
      await order.save()
    }

    if (payment.status !== 'refunded') {
      return
    }

    for (const license of await this.licensesFor(payment, order)) {
      if (!license.isRevoked) {
        await licenses.revoke(license, `Refunded (${payment.publicId})`, SYSTEM_ACTOR)
      }
    }
  }

  /**
   * A chargeback suspends — reversibly. Whether the customer keeps the
   * license is a decision with a human on the other end of it, taken in the
   * back-office; switching it off meanwhile stops a disputed payment from
   * being a free license.
   */
  async applyDispute(payment: Payment): Promise<void> {
    const order = await this.orderFor(payment)

    for (const license of await this.licensesFor(payment, order)) {
      if (license.status === 'active') {
        await licenses.suspend(license, `Payment disputed (${payment.publicId})`, SYSTEM_ACTOR)
      }
    }

    if (order) {
      logger.warn(
        { order: order.publicId, payment: payment.publicId },
        'licenses suspended for a dispute'
      )
    }
  }

  private async orderFor(payment: Payment): Promise<Order | null> {
    return Order.query().where('provider_order_id', payment.providerOrderId).first()
  }

  /**
   * The licenses a payment paid for: the order's, for a one-time purchase;
   * the subscription's, for a renewal.
   */
  private async licensesFor(payment: Payment, order: Order | null): Promise<License[]> {
    if (order) {
      return License.query().where('order_id', order.id)
    }

    if (payment.subscriptionId) {
      return License.query().where('subscription_id', payment.subscriptionId)
    }

    return []
  }

  /**
   * Whether this provider product or subscription belongs to the licensing
   * path rather than the starter's SaaS tiers (removed in M5).
   */
  async planForProduct(productId: string | null): Promise<Plan | null> {
    return productId ? Plan.findBy('provider_product_id', productId) : null
  }
}

export default new LicenseBilling()
