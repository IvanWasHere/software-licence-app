import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import mail from '@adonisjs/mail/services/main'
import testUtils from '@adonisjs/core/services/test_utils'

import User from '#models/user'
import Order from '#models/order'
import License from '#models/license'
import Payment from '#models/payment'
import Subscription from '#models/subscription'
import WebhookEvent from '#models/webhook_event'
import licenses from '#licensing/license_service'
import licensingConfig from '#config/licensing'
import orders from '#commerce/order_service'
import {
  createApiWorkspace,
  createIntegrationKey,
  createSellablePlan,
  createStaff,
  createWorkspace,
  creemLicensing,
  queuedMailsTo,
  restorePaymentProvider,
  runQueue,
  signedWebhook,
  useFakePaymentProvider,
  type FakePaymentProvider,
} from '#tests/helpers'

/**
 * Payments to licenses (licence plan §5.3, M4): the integration API that
 * starts a checkout, and the webhooks that turn money into licenses.
 */

let provider: FakePaymentProvider

function setup(group: any) {
  group.each.setup(() => {
    mail.fake()
    provider = useFakePaymentProvider()

    return () => {
      mail.restore()
      restorePaymentProvider()
    }
  })
  group.each.setup(() => testUtils.db().truncate())
}

async function deliver(client: any, body: Record<string, any>) {
  const { headers } = signedWebhook(body)
  await client.post('/webhooks/creem').redirects(0).headers(headers).json(body)
  await runQueue('default')

  return WebhookEvent.query().where('provider_event_id', body.id).firstOrFail()
}

async function pendingOrder(
  plan: Parameters<typeof orders.startCheckout>[0]['plan'],
  email = 'buyer@example.com'
) {
  const { order } = await orders.startCheckout({
    plan,
    email,
    successUrl: 'https://example.com/thanks',
  })

  return order
}

test.group('Commerce — the integration API', (group) => {
  setup(group)

  test('starts a checkout for a plan by slugs', async ({ client, assert }) => {
    const { headers } = await createIntegrationKey()
    const { product, plan } = await createSellablePlan({ slug: 'lifetime' })

    const response = await client.post('/api/v1/checkout').headers(headers).json({
      product: product.slug,
      plan: 'lifetime',
      email: 'Buyer@Example.com',
      success_url: 'https://example.com/thanks',
    })

    response.assertStatus(201)

    const order = await Order.query().preload('items').firstOrFail()
    response.assertBodyContains({
      data: {
        order_id: order.publicId,
        status: 'pending',
        checkout_url: `https://checkout.test/${plan.providerProductId}`,
      },
    })

    assert.equal(order.email, 'buyer@example.com')
    assert.equal(order.totalCents, plan.priceCents)
    assert.isNull(order.organizationId)
    assert.lengthOf(order.items, 1)

    /**
     * The one thread the webhook will be attributed by.
     */
    assert.deepEqual(provider.checkouts[0].metadata, { orderPublicId: order.publicId })
    assert.equal(provider.checkouts[0].customerEmail, 'buyer@example.com')
  })

  /**
   * A customer's key must never reach an endpoint that sells to, or looks up,
   * arbitrary addresses — however it is scoped.
   */
  test('refuses every key but the system account’s', async ({ client }) => {
    const { headers } = await createApiWorkspace()
    const { product } = await createSellablePlan({ slug: 'lifetime' })

    for (const request of [
      client.post('/api/v1/checkout').headers(headers).json({
        product: product.slug,
        plan: 'lifetime',
        email: 'x@example.com',
        success_url: 'https://example.com',
      }),
      client.get('/api/v1/orders/ord_222222222222').headers(headers),
      client.get('/api/v1/customers/licenses?email=x@example.com').headers(headers),
    ]) {
      const response = await request
      response.assertStatus(403)
      response.assertBodyContains({ error: { code: 'forbidden' } })
    }
  })

  test('an unknown plan is a 404, one not on sale a 422', async ({ client }) => {
    const { headers } = await createIntegrationKey()
    const { product, plan } = await createSellablePlan({ slug: 'lifetime' })
    const body = {
      product: product.slug,
      email: 'x@example.com',
      success_url: 'https://example.com',
    }

    const unknown = await client
      .post('/api/v1/checkout')
      .headers(headers)
      .json({ ...body, plan: 'nope' })
    unknown.assertStatus(404)

    plan.status = 'archived'
    await plan.save()

    const archived = await client
      .post('/api/v1/checkout')
      .headers(headers)
      .json({ ...body, plan: 'lifetime' })
    archived.assertStatus(422)
  })

  test('a plan with no provider product cannot be sold', async ({ client }) => {
    const { headers } = await createIntegrationKey()
    const { product, plan } = await createSellablePlan({ slug: 'lifetime' })
    plan.providerProductId = null
    await plan.save()

    const response = await client.post('/api/v1/checkout').headers(headers).json({
      product: product.slug,
      plan: 'lifetime',
      email: 'x@example.com',
      success_url: 'https://example.com',
    })

    response.assertStatus(422)
    response.assertBodyContains({ error: { details: { reason: 'not_configured' } } })
  })

  test('an order reports pending, then paid with its licenses', async ({ client, assert }) => {
    const { headers } = await createIntegrationKey()
    const { plan } = await createSellablePlan()
    const order = await pendingOrder(plan)

    const before = await client.get(`/api/v1/orders/${order.publicId}`).headers(headers)
    before.assertBodyContains({ data: { status: 'pending', licenses: [] } })

    await deliver(client, creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId }))

    const after = await client.get(`/api/v1/orders/${order.publicId}`).headers(headers)
    const license = await License.firstOrFail()

    after.assertBodyContains({
      data: { status: 'paid', licenses: [{ id: license.publicId, key_suffix: license.keySuffix }] },
    })

    /**
     * The key itself goes to the buyer, never through this API.
     */
    assert.notInclude(JSON.stringify(after.body()), license.keyEncrypted)
  })

  test('looks up a customer’s licenses by email', async ({ client }) => {
    const { headers } = await createIntegrationKey()
    const { plan } = await createSellablePlan()
    const order = await pendingOrder(plan, 'owner@example.com')
    await deliver(client, creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId }))
    const license = await License.firstOrFail()

    const found = await client
      .get('/api/v1/customers/licenses?email=Owner@Example.com')
      .headers(headers)
    found.assertBodyContains({ data: [{ id: license.publicId }] })

    const none = await client
      .get('/api/v1/customers/licenses?email=nobody@example.com')
      .headers(headers)
    none.assertBody({ data: [] })
  })
})

test.group('Commerce — one-time purchases', (group) => {
  setup(group)

  test('a paid checkout issues a perpetual license to a new account', async ({
    client,
    assert,
  }) => {
    const { plan, product } = await createSellablePlan()
    const order = await pendingOrder(plan, 'new@example.com')

    const ledger = await deliver(
      client,
      creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId, providerOrderId: 'ord_c1' })
    )

    assert.isNotNull(ledger.processedAt)
    assert.equal(ledger.eventType, 'order.completed')

    await order.refresh()
    assert.equal(order.status, 'paid')
    assert.equal(order.providerOrderId, 'ord_c1')
    assert.isNotNull(order.fulfilledAt)

    const user = await User.findByOrFail('email', 'new@example.com')
    assert.equal(order.organizationId, user.organizationId)
    assert.isFalse(user.hasPassword)

    const license = await License.firstOrFail()
    assert.equal(license.source, 'order')
    assert.equal(license.orderId, order.id)
    assert.equal(license.organizationId, user.organizationId)
    assert.isNull(license.expiresAt)
    const { result } = await licenses.check(license.keyEncrypted, product.slug)
    assert.isTrue(result.valid)

    const payment = await Payment.findByOrFail('provider_order_id', 'ord_c1')
    assert.equal(payment.organizationId, user.organizationId)
    assert.equal(payment.amountCents, 39_900)

    /**
     * The key, by email, with the way in for an account that has no password.
     */
    const mails = await queuedMailsTo('new@example.com')
    const keysMail = mails.find((queued) => queued.subject.includes('license key'))
    assert.exists(keysMail)
    assert.include(keysMail!.html, license.keyEncrypted)
    assert.include(keysMail!.html, 'Set a password')
    assert.include(keysMail!.text, license.keyEncrypted)
  })

  test('buying with an existing account’s email adds to that account', async ({
    client,
    assert,
  }) => {
    const { organization } = await createWorkspace({ email: 'existing@example.com' })
    const { plan } = await createSellablePlan()
    const order = await pendingOrder(plan, 'existing@example.com')

    await deliver(client, creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId }))

    const license = await License.firstOrFail()
    assert.equal(license.organizationId, organization.id)
    assert.lengthOf(await User.query().where('email', 'existing@example.com'), 1)
  })

  /**
   * Creem retries, and the queue is at-least-once: however many times the
   * paid event arrives, one license.
   */
  test('a redelivered or replayed payment issues one license', async ({ client, assert }) => {
    const { plan } = await createSellablePlan()
    const order = await pendingOrder(plan)

    await deliver(client, creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId }))
    await deliver(client, creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId }))
    await orders.fulfil(order)

    assert.lengthOf(await License.all(), 1)
  })

  test('a payment for an order we do not know is parked, not guessed at', async ({
    client,
    assert,
  }) => {
    const ledger = await deliver(
      client,
      creemLicensing.oneTimeCheckout({ orderPublicId: 'ord_222222222222' })
    )

    assert.isNull(ledger.processedAt)
    assert.include(ledger.lastError, 'could not be attributed to an order')
    assert.lengthOf(await License.all(), 0)
  })

  test('a full refund revokes the license', async ({ client, assert }) => {
    const { plan, product } = await createSellablePlan()
    const order = await pendingOrder(plan)
    await deliver(
      client,
      creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId, providerOrderId: 'ord_r1' })
    )

    await deliver(client, creemLicensing.refund({ providerOrderId: 'ord_r1', amountCents: 39_900 }))

    const license = await License.firstOrFail()
    assert.equal(license.status, 'revoked')
    await order.refresh()
    assert.equal(order.status, 'refunded')

    const { result } = await licenses.check(license.keyEncrypted, product.slug)
    assert.equal(result.reason, 'license_revoked')
  })

  test('a partial refund is recorded and leaves the license alone', async ({ client, assert }) => {
    const { plan } = await createSellablePlan()
    const order = await pendingOrder(plan)
    await deliver(
      client,
      creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId, providerOrderId: 'ord_r2' })
    )

    await deliver(client, creemLicensing.refund({ providerOrderId: 'ord_r2', amountCents: 5_000 }))

    const license = await License.firstOrFail()
    assert.equal(license.status, 'active')
    await order.refresh()
    assert.equal(order.status, 'partially_refunded')
  })

  test('a dispute suspends the license, reversibly', async ({ client, assert }) => {
    const { plan } = await createSellablePlan()
    const order = await pendingOrder(plan)
    await deliver(
      client,
      creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId, providerOrderId: 'ord_d1' })
    )

    await deliver(client, creemLicensing.dispute({ providerOrderId: 'ord_d1' }))

    const license = await License.firstOrFail()
    assert.equal(license.status, 'suspended')
    assert.include(license.statusReason, 'disputed')
  })
})

test.group('Commerce — subscriptions', (group) => {
  setup(group)

  const yearly = { billing: 'yearly' as const, licenseTerm: 'subscription' as const }

  test('a subscription checkout issues a license that expires with the period', async ({
    client,
    assert,
  }) => {
    const { plan, product } = await createSellablePlan(yearly)
    const order = await pendingOrder(plan)
    const periodEnd = DateTime.utc().plus({ years: 1 }).startOf('second')

    await deliver(
      client,
      creemLicensing.subscription({
        orderPublicId: order.publicId,
        productId: plan.providerProductId!,
        currentPeriodEnd: periodEnd.toISO()!,
      })
    )

    const subscription = await Subscription.firstOrFail()
    assert.equal(subscription.planId, plan.id)

    const license = await License.firstOrFail()
    assert.equal(license.subscriptionId, subscription.id)
    assert.equal(
      license.expiresAt!.toMillis(),
      periodEnd.plus({ days: licensingConfig.renewalGraceDays }).toMillis()
    )

    /**
     * A customer account holds licenses, not a tier: the organisation's
     * SaaS plan is untouched by a license subscription.
     */
    await order.refresh()
    const user = await User.findByOrFail('email', 'buyer@example.com')
    await user.load('organization')
    assert.equal(user.organization.planKey, 'standard')

    const { result } = await licenses.check(license.keyEncrypted, product.slug)
    assert.isTrue(result.valid)
  })

  /**
   * Creem sends checkout.completed, subscription.active and subscription.paid
   * for one checkout. Between them: one subscription, one license.
   */
  test('the three events of one checkout issue one license', async ({ client, assert }) => {
    const { plan } = await createSellablePlan(yearly)
    const order = await pendingOrder(plan)
    const common = { orderPublicId: order.publicId, productId: plan.providerProductId! }

    await deliver(client, creemLicensing.subscription(common))
    await deliver(
      client,
      creemLicensing.subscription({ ...common, eventType: 'subscription.active' })
    )
    await deliver(
      client,
      creemLicensing.subscription({ ...common, eventType: 'subscription.paid' })
    )

    assert.lengthOf(await Subscription.all(), 1)
    assert.lengthOf(await License.all(), 1)
  })

  test('a renewal moves the expiry to the new period', async ({ client, assert }) => {
    const { plan } = await createSellablePlan(yearly)
    const order = await pendingOrder(plan)
    await deliver(
      client,
      creemLicensing.subscription({
        orderPublicId: order.publicId,
        productId: plan.providerProductId!,
      })
    )

    const renewedTo = DateTime.utc().plus({ years: 2 }).startOf('second')

    await deliver(
      client,
      creemLicensing.subscription({
        eventType: 'subscription.paid',
        productId: plan.providerProductId!,
        currentPeriodEnd: renewedTo.toISO()!,
        providerOrderId: 'ord_renewal_1',
      })
    )

    const license = await License.firstOrFail()
    assert.equal(
      license.expiresAt!.toMillis(),
      renewedTo.plus({ days: licensingConfig.renewalGraceDays }).toMillis()
    )

    /**
     * And the renewal's money is recorded against the same customer.
     */
    const payment = await Payment.findByOrFail('provider_order_id', 'ord_renewal_1')
    assert.equal(payment.organizationId, license.organizationId)
  })

  /**
   * A failed card starts dunning; the license keeps working until the period
   * plus the grace runs out, which is what the expiry already says.
   */
  test('past due keeps the license valid', async ({ client, assert }) => {
    const { plan, product } = await createSellablePlan(yearly)
    const order = await pendingOrder(plan)
    await deliver(
      client,
      creemLicensing.subscription({
        orderPublicId: order.publicId,
        productId: plan.providerProductId!,
      })
    )

    await deliver(
      client,
      creemLicensing.subscription({
        eventType: 'subscription.past_due',
        productId: plan.providerProductId!,
        status: 'past_due',
      })
    )

    const license = await License.firstOrFail()
    const { result } = await licenses.check(license.keyEncrypted, product.slug)
    assert.isTrue(result.valid)
  })

  test('an ended subscription makes the license subscription_inactive', async ({
    client,
    assert,
  }) => {
    const { plan, product } = await createSellablePlan(yearly)
    const order = await pendingOrder(plan)
    await deliver(
      client,
      creemLicensing.subscription({
        orderPublicId: order.publicId,
        productId: plan.providerProductId!,
      })
    )

    await deliver(
      client,
      creemLicensing.subscription({
        eventType: 'subscription.expired',
        productId: plan.providerProductId!,
        status: 'expired',
      })
    )

    const license = await License.firstOrFail()
    const { result } = await licenses.check(license.keyEncrypted, product.slug)
    assert.equal(result.reason, 'subscription_inactive')
  })
})

test.group('Commerce — the back-office', (group) => {
  setup(group)

  test('support finds an order by email and sees its license', async ({ client }) => {
    const support = await createStaff({ role: 'support' })
    const { plan } = await createSellablePlan()
    const order = await pendingOrder(plan, 'buyer@example.com')
    await deliver(client, creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId }))
    const license = await License.firstOrFail()

    const list = await client
      .get('/admin/orders?q=buyer@example.com')
      .withGuard('staff')
      .loginAs(support)
    list.assertStatus(200)
    list.assertTextIncludes(order.publicId)

    const show = await client
      .get(`/admin/orders/${order.publicId}`)
      .withGuard('staff')
      .loginAs(support)
    show.assertStatus(200)
    show.assertTextIncludes(license.publicId)

    const licensePage = await client
      .get(`/admin/licenses/${license.publicId}`)
      .withGuard('staff')
      .loginAs(support)
    licensePage.assertTextIncludes(order.publicId)
  })

  test('a pending order says so', async ({ client }) => {
    const support = await createStaff({ role: 'support' })
    const { plan } = await createSellablePlan()
    const order = await pendingOrder(plan)

    const show = await client
      .get(`/admin/orders/${order.publicId}`)
      .withGuard('staff')
      .loginAs(support)

    show.assertTextIncludes('Issued when the payment provider confirms the payment.')
  })
})
