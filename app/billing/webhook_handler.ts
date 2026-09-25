import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'

import Payment from '#models/payment'
import Subscription from '#models/subscription'
import Organization from '#models/organization'
import type WebhookEvent from '#models/webhook_event'
import Plan from '#models/plan'
import orders from '#commerce/order_service'
import licenseBilling from '#commerce/license_billing'
import mailer from '#mail/mailer_service'
import { paymentProvider } from '#billing/provider'
import type { NormalizedEvent, ProviderSubscription } from '#billing/contracts'
import PaymentReceiptNotification from '#mail/mails/payment_receipt_notification'
import PaymentFailedNotification from '#mail/mails/payment_failed_notification'

/**
 * Applies a normalized event to the domain (plan §7.5, step 4).
 *
 * Three rules hold everything here together:
 *
 * 1. **Idempotent.** The queue is at-least-once and Creem retries five times,
 *    so every write is an upsert keyed on the provider's own id. Running the
 *    same event twice must leave the same rows.
 * 2. **Ordered by watermark, not by arrival.** Webhooks can arrive out of
 *    order. An event describing a subscription state older than what the row
 *    already knows is ignored rather than applied — otherwise a late
 *    `past_due` can undo the `active` that superseded it.
 * 3. **The provider is the truth.** On any ambiguity — a payload with no
 *    status, a subscription we cannot attribute — we re-fetch from the
 *    provider rather than guess from the payload (plan §7.5).
 */
export class WebhookHandler {
  async apply(event: NormalizedEvent): Promise<void> {
    switch (event.type) {
      case 'subscription.activated':
      case 'subscription.trialing':
      case 'subscription.updated':
      case 'subscription.past_due':
      case 'subscription.paused':
      case 'subscription.canceled':
        await this.applySubscription(event)
        break

      case 'payment.succeeded':
      case 'payment.refunded': {
        /**
         * A renewal carries the subscription it renewed. On the licensing
         * path that is what moves the license's expiry, so the subscription
         * is applied first and the money recorded against it second.
         */
        if (event.subscription && (await this.isLicensing(event, event.subscription))) {
          await this.applyLicensingSubscription(event, event.subscription)
        }

        const payment = await this.applyPayment(event)

        if (payment && event.type === 'payment.refunded') {
          await licenseBilling.applyRefund(payment)
        }
        break
      }

      case 'dispute.created':
        await this.applyDispute(event)
        break

      case 'order.completed':
        await this.applyOrder(event)
        break
    }
  }

  /**
   * A one-time purchase was paid (licence plan §5.3): fulfil the order —
   * account, license, email — then record the money against it.
   *
   * Attributed through the order id we put in the checkout metadata, and
   * nothing else. A one-time payment we cannot tie to one of our orders is
   * parked for a human, exactly as an unattributable subscription is.
   */
  private async applyOrder(event: NormalizedEvent): Promise<void> {
    const order = await orders.find(event.orderPublicId)

    if (!order) {
      throw new Error(`Webhook ${event.providerEventId} could not be attributed to an order`)
    }

    const { order: fulfilled } = await orders.fulfil(order, {
      providerOrderId: event.payment?.orderId ?? null,
      paidAt: event.payment?.occurredAt ?? event.occurredAt,
    })

    const organization = await Organization.findOrFail(fulfilled.organizationId)
    await this.applyPayment(event, organization)
  }

  /**
   * Whether a subscription belongs to the licensing path (M4) rather than the
   * starter's SaaS tiers, which are removed in M5: a row we already tied to a
   * plan, an order of ours in the metadata, or a provider product mapped to a
   * catalog plan.
   */
  private async isLicensing(
    event: NormalizedEvent,
    incoming: ProviderSubscription
  ): Promise<boolean> {
    if (event.orderPublicId) {
      return true
    }

    const existing = await Subscription.query()
      .where('provider', 'creem')
      .where('provider_subscription_id', incoming.id)
      .first()

    if (existing) {
      return existing.isLicensing
    }

    return Boolean(await licenseBilling.planForProduct(incoming.productId))
  }

  /**
   * A subscription that keeps a license alive (licence plan §5.3).
   *
   * The same three rules as the SaaS path — idempotent, watermark-ordered,
   * provider is the truth — but it never touches `organizations.plan_key`:
   * a customer account holds many licenses, not one tier. Its effect is on
   * the licenses tied to it, through their expiry; whether they are valid is
   * then decided on every validate call from the subscription's status.
   */
  private async applyLicensingSubscription(
    event: NormalizedEvent,
    incoming: ProviderSubscription
  ): Promise<void> {
    const existing = await Subscription.query()
      .where('provider', 'creem')
      .where('provider_subscription_id', incoming.id)
      .first()

    if (existing && event.occurredAt < existing.watermark.minus({ seconds: 1 })) {
      logger.info(
        { event: event.providerEventId, subscription: incoming.id },
        'ignored a webhook older than the subscription it describes'
      )
      return
    }

    const claimed = await orders.find(event.orderPublicId)

    /**
     * An order named in the metadata is only believed when it agrees with
     * the subscription we already know: same account, and not already paid
     * for by a different provider subscription. Otherwise a replayed event
     * with an edited order id could issue somebody else's license on this
     * subscription.
     */
    const order =
      claimed &&
      (!existing ||
        !claimed.organizationId ||
        claimed.organizationId === existing.organizationId) &&
      (!claimed.providerSubscriptionId || claimed.providerSubscriptionId === incoming.id)
        ? claimed
        : null

    if (claimed && !order) {
      logger.warn(
        { event: event.providerEventId, order: claimed.publicId, subscription: incoming.id },
        'ignored an order id that does not belong to this subscription'
      )
    }

    const organization = existing
      ? await Organization.find(existing.organizationId)
      : order
        ? await orders.ensureAccount(order)
        : null

    if (!organization) {
      throw new Error(`Webhook ${event.providerEventId} could not be attributed to an order`)
    }

    const plan = existing?.planId
      ? await Plan.find(existing.planId)
      : ((await licenseBilling.planForProduct(incoming.productId)) ??
        (order ? await this.planOf(order.id) : null))

    if (!plan) {
      throw new Error(`Subscription ${incoming.id} maps to no catalog plan`)
    }

    if (event.type === 'subscription.canceled' && !incoming.currentPeriodEnd) {
      incoming = (await this.refetch(incoming.id)) ?? incoming
    }

    const previousStatus = existing?.status ?? null
    const subscription = await this.upsertSubscription(organization, incoming, 'license', plan.id)

    /**
     * Money has moved once the subscription is entitling; that is when the
     * order's license is issued. `fulfil` skips items that already have one,
     * so `checkout.completed`, `subscription.active` and `subscription.paid`
     * for the same checkout issue exactly one license between them.
     */
    if (order && subscription.isEntitling) {
      await orders.fulfil(order, { subscription, paidAt: event.occurredAt })
    }

    await licenseBilling.syncExpiry(subscription)
    await this.notifyRenewalFailed(organization, subscription, plan, previousStatus)
  }

  /**
   * The dunning email (licence plan §5.3), on the *transition* to past due
   * only: Creem re-sends the same state, and a customer must not get five
   * "payment failed" emails because a webhook was retried.
   */
  private async notifyRenewalFailed(
    organization: Organization,
    subscription: Subscription,
    plan: Plan,
    previousStatus: string | null
  ): Promise<void> {
    if (subscription.status !== 'past_due' || previousStatus === 'past_due') {
      return
    }

    const owner = await this.ownerOf(organization)

    if (!owner) {
      return
    }

    const { default: License } = await import('#models/license')
    const license = await License.query().where('subscription_id', subscription.id).first()
    await plan.load('product')

    await mailer.send(
      new PaymentFailedNotification(owner, organization, subscription, {
        productName: plan.product.name,
        licenseExpiresAt: license?.expiresAt ?? null,
      })
    )
  }

  private async planOf(orderId: number): Promise<Plan | null> {
    const { default: OrderItem } = await import('#models/order_item')
    const item = await OrderItem.query().where('order_id', orderId).first()

    return item ? Plan.find(item.planId) : null
  }

  /**
   * A subscription event (licence plan §5.3). Every subscription keeps a
   * license alive; one for a product that is no catalog plan is parked for a
   * human. Licenses change because the provider said money moved, never
   * because a browser hit a return URL (plan §7.5).
   */
  private async applySubscription(event: NormalizedEvent): Promise<void> {
    let incoming = event.subscription

    /**
     * A subscription event with no subscription object is exactly the
     * "ambiguity" case: ask the provider rather than infer.
     */
    if (!incoming && event.type !== 'subscription.canceled') {
      logger.warn({ event: event.providerEventId }, 'subscription event carried no subscription')
      return
    }

    if (!incoming) {
      return
    }

    if (await this.isLicensing(event, incoming)) {
      return this.applyLicensingSubscription(event, incoming)
    }

    /**
     * A subscription for a provider product that is no catalog plan, with no
     * order of ours behind it. Since the starter's SaaS tiers went (licence
     * plan M5) nothing else can be paid for, so this is somebody selling
     * outside the catalog — parked for a human rather than guessed at.
     */
    throw new Error(
      `Subscription ${incoming.id} could not be attributed: product ${incoming.productId ?? 'unknown'} maps to no catalog plan`
    )
  }

  private async upsertSubscription(
    organization: Organization,
    incoming: ProviderSubscription,
    planKey: string,
    planId: number | null = null
  ): Promise<Subscription> {
    /**
     * Keyed on the provider's id so a redelivery updates rather than inserts
     * — the same defence the unique index gives, applied before the database
     * has to reject anything.
     */
    return db.transaction(async (trx) => {
      const subscription =
        (await Subscription.query({ client: trx })
          .where('provider', 'creem')
          .where('provider_subscription_id', incoming.id)
          .first()) ?? new Subscription()

      subscription.useTransaction(trx)

      subscription.merge({
        organizationId: organization.id,
        provider: 'creem',
        providerSubscriptionId: incoming.id,
        providerCustomerId: incoming.customerId ?? subscription.providerCustomerId ?? null,
        planKey,
        planId: planId ?? subscription.planId ?? null,
        status: incoming.status,
        currentPeriodStart: incoming.currentPeriodStart,
        currentPeriodEnd: incoming.currentPeriodEnd,
        cancelAtPeriodEnd: incoming.cancelAtPeriodEnd,
        trialEndsAt: incoming.trialEndsAt,
        canceledAt: incoming.canceledAt,
      })

      await subscription.save()

      return subscription
    })
  }

  /**
   * Record money that moved.
   *
   * Payments are upserted on `provider_order_id`, so a refund event for an
   * order we already have grows `refunded_amount_cents` on the existing row
   * rather than writing a second, contradictory one.
   */
  private async applyPayment(
    event: NormalizedEvent,
    organizationOverride?: Organization
  ): Promise<Payment | null> {
    const incoming = event.payment

    if (!incoming) {
      logger.warn({ event: event.providerEventId }, 'payment event carried no payment')
      return null
    }

    /**
     * The order's own `subscription` reference when it has one, and otherwise
     * the subscription the event itself is about — Creem's `subscription.paid`
     * puts the order *inside* the subscription rather than pointing back at
     * it, so reading only the order would leave every renewal unattributable.
     */
    const providerSubscriptionId = incoming.subscriptionId ?? event.subscription?.id ?? null

    const subscription = providerSubscriptionId
      ? await Subscription.query()
          .where('provider', 'creem')
          .where('provider_subscription_id', providerSubscriptionId)
          .first()
      : null

    const organization =
      organizationOverride ??
      (subscription
        ? await Organization.find(subscription.organizationId)
        : ((await this.organizationFromEvent(event)) ??
          (await this.organizationFromOrder(incoming.orderId))))

    if (!organization) {
      throw new Error(`Payment ${incoming.orderId} could not be attributed to an organisation`)
    }

    const isRefund = event.type === 'payment.refunded'

    const payment =
      (await Payment.query()
        .where('provider', 'creem')
        .where('provider_order_id', incoming.orderId)
        .first()) ?? new Payment()

    const refunded = isRefund
      ? Math.max(payment.refundedAmountCents ?? 0, incoming.refundedAmountCents)
      : (payment.refundedAmountCents ?? 0)

    const amount = payment.amountCents || incoming.amountCents

    payment.merge({
      organizationId: organization.id,
      subscriptionId: subscription?.id ?? payment.subscriptionId ?? null,
      provider: 'creem',
      providerOrderId: incoming.orderId,
      amountCents: amount,
      currency: incoming.currency,
      refundedAmountCents: refunded,
      status: this.paymentStatus(amount, refunded),
      description: incoming.description ?? payment.description ?? null,
      receiptUrl: incoming.receiptUrl ?? payment.receiptUrl ?? null,
      occurredAt: payment.occurredAt ?? incoming.occurredAt,
    })

    const isNew = !payment.$isPersisted
    await payment.save()

    /**
     * A receipt for a charge, once. A refund is not emailed from here — the
     * provider sends its own credit note, and a second one from us reads as a
     * second refund.
     */
    if (isNew && !isRefund) {
      const owner = await this.ownerOf(organization)

      if (owner) {
        await mailer.send(new PaymentReceiptNotification(owner, organization, payment))
      }
    }

    return payment
  }

  /**
   * A refund or dispute for a one-time purchase names only the provider's
   * order; our order row, which recorded it at fulfilment, knows the account.
   */
  private async organizationFromOrder(providerOrderId: string): Promise<Organization | null> {
    const { default: Order } = await import('#models/order')
    const order = await Order.query().where('provider_order_id', providerOrderId).first()

    return order?.organizationId ? Organization.find(order.organizationId) : null
  }

  private paymentStatus(
    amountCents: number,
    refundedCents: number
  ): 'succeeded' | 'refunded' | 'partially_refunded' {
    if (refundedCents <= 0) {
      return 'succeeded'
    }

    return refundedCents >= amountCents ? 'refunded' : 'partially_refunded'
  }

  /**
   * A chargeback.
   *
   * Deliberately does nothing automatic beyond marking the payment and
   * logging loudly: suspending a workspace over a dispute is a decision with
   * a human on the other end of it, and it belongs in the admin panel (M7),
   * not in a webhook handler.
   */
  private async applyDispute(event: NormalizedEvent): Promise<void> {
    const orderId = event.payment?.orderId

    if (orderId) {
      const payment = await Payment.query()
        .where('provider', 'creem')
        .where('provider_order_id', orderId)
        .first()

      if (payment) {
        payment.status = 'disputed'
        await payment.save()
        await licenseBilling.applyDispute(payment)
      }
    }

    logger.error(
      { event: event.providerEventId, orderId },
      'a payment was disputed — review it in the admin panel'
    )
  }

  private async organizationFromEvent(event: NormalizedEvent): Promise<Organization | null> {
    if (!event.organizationPublicId) {
      return null
    }

    return Organization.query()
      .where('public_id', event.organizationPublicId)
      .whereNull('deleted_at')
      .first()
  }

  private async ownerOf(organization: Organization) {
    const { default: User } = await import('#models/user')

    return User.query()
      .where('organization_id', organization.id)
      .where('role', 'owner')
      .whereNull('deleted_at')
      .first()
  }

  /**
   * Ask the provider what is actually true. Used only where the payload is
   * ambiguous — never as a matter of course, because it turns every webhook
   * into an outbound call.
   */
  private async refetch(subscriptionId: string): Promise<ProviderSubscription | null> {
    try {
      return await paymentProvider().getSubscription(subscriptionId)
    } catch (error) {
      logger.warn({ err: error, subscriptionId }, 'could not re-fetch a subscription from Creem')
      return null
    }
  }
}

export default new WebhookHandler()

/**
 * Stamp a ledger row as done. Kept next to the handler because the ledger and
 * the handler are two halves of one guarantee: an event is applied exactly
 * once, and the row is the proof.
 */
export async function markProcessed(ledger: WebhookEvent): Promise<void> {
  ledger.processedAt = DateTime.utc()
  ledger.lastError = null
  await ledger.save()
}
