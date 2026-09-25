import router from '@adonisjs/core/services/router'

import env from '#start/env'
import Order from '#models/order'
import Payment from '#models/payment'
import Subscription from '#models/subscription'
import type Organization from '#models/organization'
import { paymentProvider } from '#billing/provider'

export class BillingError extends Error {
  constructor(
    message: string,
    readonly reason: 'no_subscription' | 'no_customer'
  ) {
    super(message)
  }
}

/**
 * The owner's billing screen, for a licensing account (licence plan §6, M5).
 *
 * Nothing is bought here any more — licenses are bought on a product's
 * pricing page or through our website — so this is the record: orders, the
 * subscriptions that keep licenses alive, every charge and refund, and the way
 * into the provider's own portal to change a card or cancel.
 */
export class BillingService {
  /**
   * Send the owner to the provider's portal to change a card, download an
   * invoice or cancel a subscription.
   *
   * We deliberately do not rebuild any of that: card details never touch this
   * application, and a cancellation decided there comes back as a webhook like
   * every other state change.
   */
  async startPortal(organization: Organization): Promise<{ url: string }> {
    const subscription = await Subscription.query()
      .where('organization_id', organization.id)
      .orderBy('id', 'desc')
      .first()

    if (!subscription) {
      throw new BillingError(
        'There is no subscription to manage. One-time purchases have nothing to cancel.',
        'no_subscription'
      )
    }

    if (!subscription.providerCustomerId) {
      /**
       * A subscription recorded before the provider told us who the customer
       * was — rare, and recoverable by re-fetching rather than by showing the
       * owner a dead button.
       */
      const theirs = await paymentProvider().getSubscription(subscription.providerSubscriptionId)

      if (!theirs?.customerId) {
        throw new BillingError(
          'We do not have a billing profile for this account yet. Try again in a moment.',
          'no_customer'
        )
      }

      subscription.providerCustomerId = theirs.customerId
      await subscription.save()
    }

    return paymentProvider().createPortalSession({
      customerId: subscription.providerCustomerId!,
      returnUrl: `${env.get('APP_URL')}${router.makeUrl('billing.index')}`,
    })
  }

  /**
   * Transaction history (plan §13.5). Capped rather than paginated: the
   * provider's portal is the complete record.
   */
  async payments(organization: Organization, limit = 24): Promise<Payment[]> {
    return Payment.query()
      .where('organization_id', organization.id)
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
  }

  async overview(organization: Organization) {
    const [orders, subscriptions, payments] = await Promise.all([
      Order.query()
        .where('organization_id', organization.id)
        .whereNot('status', 'pending')
        .preload('items', (items) => items.preload('plan', (plan) => plan.preload('product')))
        .orderBy('id', 'desc')
        .limit(24),
      Subscription.query()
        .where('organization_id', organization.id)
        .whereNotNull('plan_id')
        .preload('plan', (plan) => plan.preload('product'))
        .orderBy('id', 'desc'),
      this.payments(organization),
    ])

    return { orders, subscriptions, payments }
  }
}

export default new BillingService()
