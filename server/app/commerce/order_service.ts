import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'

import Plan from '#models/plan'
import User from '#models/user'
import Order from '#models/order'
import License from '#models/license'
import OrderItem from '#models/order_item'
import Organization from '#models/organization'
import type Subscription from '#models/subscription'
import mailer from '#mail/mailer_service'
import licensingConfig from '#config/licensing'
import accounts from '#commerce/customer_accounts'
import { paymentProvider } from '#billing/provider'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'
import LicenseIssuedNotification from '#mail/mails/license_issued_notification'

export class OrderError extends Error {
  constructor(
    message: string,
    readonly reason: 'not_purchasable' | 'not_configured'
  ) {
    super(message)
  }
}

export interface CheckoutRequest {
  plan: Plan
  email: string
  successUrl: string
}

export interface Fulfilment {
  order: Order
  licenses: License[]
  accountCreated: boolean
}

/**
 * Orders from checkout to license (licence plan §5.3, M4).
 *
 * Two moments, each owned here:
 *
 * 1. **Checkout.** We write a pending order and its item *first*, then ask the
 *    provider for a checkout URL carrying the order's public id. The order row
 *    is what the eventual webhook is attributed to.
 * 2. **Fulfilment.** When the provider says money moved, the order is marked
 *    paid, the customer account is found or created, and one license is
 *    issued per item — all in one transaction, behind a lock on the order
 *    row, so the two or three webhooks Creem sends for one checkout can race
 *    each other and still issue exactly one license.
 */
export class OrderService {
  async startCheckout(request: CheckoutRequest): Promise<{ order: Order; url: string }> {
    const plan = request.plan
    await plan.load('product')

    if (plan.isArchived || plan.product.status !== 'active') {
      throw new OrderError(`${plan.product.name} · ${plan.name} is not on sale.`, 'not_purchasable')
    }

    if (!plan.providerProductId) {
      throw new OrderError(
        `${plan.name} has no payment-provider product. Set it on the plan in the back-office.`,
        'not_configured'
      )
    }

    const order = await db.transaction(async (trx) => {
      const created = await Order.create(
        {
          email: request.email.trim().toLowerCase(),
          status: 'pending',
          totalCents: plan.priceCents,
          currency: plan.currency,
          provider: 'creem',
        },
        { client: trx }
      )

      await OrderItem.create(
        { orderId: created.id, planId: plan.id, quantity: 1, unitPriceCents: plan.priceCents },
        { client: trx }
      )

      return created
    })

    const { url, sessionId } = await paymentProvider().createCheckoutSession({
      productId: plan.providerProductId,
      customerEmail: order.email,
      successUrl: request.successUrl,
      metadata: { orderPublicId: order.publicId },
    })

    order.providerCheckoutId = sessionId || null
    await order.save()

    return { order, url }
  }

  async find(publicId: string | undefined | null): Promise<Order | null> {
    if (!publicId) {
      return null
    }

    return Order.query().where('public_id', publicId).first()
  }

  /**
   * The customer account an order belongs to, found or created from the
   * order's own email. Separate from `fulfil` because a subscription row needs
   * its organisation before the license that points at it can be issued.
   */
  async ensureAccount(order: Order): Promise<Organization> {
    return db.transaction(async (trx) => {
      const locked = await Order.query({ client: trx })
        .where('id', order.id)
        .forUpdate()
        .firstOrFail()

      if (!locked.organizationId) {
        const account = await accounts.forEmail(locked.email, trx)
        locked.organizationId = account.organization.id
        locked.useTransaction(trx)
        await locked.save()
      }

      order.organizationId = locked.organizationId

      return Organization.findOrFail(locked.organizationId, { client: trx })
    })
  }

  /**
   * Mark an order paid and issue what it bought. Safe to call any number of
   * times, concurrently: the order row is locked, and an item that already
   * has its license is skipped.
   *
   * `subscription` is passed for a recurring plan, so the license is tied to
   * it and expires with its paid period (plus the renewal grace).
   */
  async fulfil(
    order: Order,
    details: {
      providerOrderId?: string | null
      paidAt?: DateTime | null
      subscription?: Subscription | null
    } = {}
  ): Promise<Fulfilment> {
    const outcome = await db.transaction(async (trx) => {
      const locked = await Order.query({ client: trx })
        .where('id', order.id)
        .forUpdate()
        .firstOrFail()

      let accountCreated = false

      if (!locked.organizationId) {
        const account = await accounts.forEmail(locked.email, trx)
        locked.organizationId = account.organization.id
        accountCreated = account.created
      }

      if (locked.status === 'pending') {
        locked.status = 'paid'
        locked.paidAt = details.paidAt ?? DateTime.utc()
      }

      if (details.providerOrderId && !locked.providerOrderId) {
        locked.providerOrderId = details.providerOrderId
      }

      if (details.subscription && !locked.providerSubscriptionId) {
        locked.providerSubscriptionId = details.subscription.providerSubscriptionId
      }

      const organization = await Organization.findOrFail(locked.organizationId, { client: trx })
      const items = await OrderItem.query({ client: trx }).where('order_id', locked.id)
      const issued: { license: License; key: string }[] = []

      for (const item of items) {
        const existing = await License.query({ client: trx })
          .where('order_item_id', item.id)
          .first()

        if (existing) {
          continue
        }

        const plan = await Plan.findOrFail(item.planId, { client: trx })

        issued.push(
          await licenses.issue({
            organization,
            plan,
            source: 'order',
            actor: SYSTEM_ACTOR,
            orderId: locked.id,
            orderItemId: item.id,
            subscriptionId: details.subscription?.id ?? null,
            expiresAt:
              plan.licenseTerm === 'subscription'
                ? subscriptionLicenseExpiry(plan, details.subscription ?? null)
                : null,
            client: trx,
          })
        )
      }

      if (!locked.fulfilledAt && issued.length) {
        locked.fulfilledAt = DateTime.utc()
      }

      locked.useTransaction(trx)
      await locked.save()

      return { order: locked, issued, organization, accountCreated }
    })

    /**
     * The keys, once, after the transaction has committed — an email about a
     * license that then rolled back would be worse than a late one.
     */
    if (outcome.issued.length) {
      await this.sendKeys(
        outcome.order,
        outcome.organization,
        outcome.issued,
        outcome.accountCreated
      )
    }

    return {
      order: outcome.order,
      licenses: outcome.issued.map(({ license }) => license),
      accountCreated: outcome.accountCreated,
    }
  }

  /**
   * Record a refund against the order it pays for.
   */
  async markRefunded(order: Order, refundedCents: number): Promise<void> {
    order.status = refundedCents >= order.totalCents ? 'refunded' : 'partially_refunded'
    await order.save()
  }

  private async sendKeys(
    order: Order,
    organization: Organization,
    issued: { license: License; key: string }[],
    accountCreated: boolean
  ) {
    const owner = await User.query()
      .where('organization_id', organization.id)
      .where('role', 'owner')
      .whereNull('deleted_at')
      .first()

    /**
     * To the address that bought, which is also the owner's for a new
     * account. For an existing account the buyer may be a member; the owner
     * sees the license in the account either way.
     */
    try {
      for (const { license } of issued) {
        await license.load((loader) => loader.load('product').load('plan'))
      }

      await mailer.send(
        new LicenseIssuedNotification(order.email, issued, {
          needsPassword: accountCreated || !owner?.hasPassword,
        })
      )
    } catch (error) {
      /**
       * The license exists and is in the account; a failed email is logged,
       * never allowed to undo a paid order.
       */
      logger.error({ err: error, order: order.publicId }, 'could not queue the license email')
    }
  }
}

/**
 * When a subscription license lapses: the end of the paid period plus the
 * renewal grace (licence plan §5.3). With no period from the provider yet,
 * one billing interval from now stands in until the first renewal event
 * corrects it.
 */
export function subscriptionLicenseExpiry(plan: Plan, subscription: Subscription | null): DateTime {
  const periodEnd =
    subscription?.currentPeriodEnd ??
    DateTime.utc().plus(plan.billing === 'monthly' ? { months: 1 } : { years: 1 })

  return periodEnd.plus({ days: licensingConfig.renewalGraceDays }).toUTC().set({ millisecond: 0 })
}

export default new OrderService()
