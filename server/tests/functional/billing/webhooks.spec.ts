import { test } from '@japa/runner'
import mail from '@adonisjs/mail/services/main'
import testUtils from '@adonisjs/core/services/test_utils'

import Job from '#models/job'
import Payment from '#models/payment'
import Subscription from '#models/subscription'
import Organization from '#models/organization'
import License from '#models/license'
import WebhookEvent from '#models/webhook_event'
import orders from '#commerce/order_service'
import {
  createSellablePlan,
  createWorkspace,
  creemLicensing,
  queuedMailsTo,
  restorePaymentProvider,
  runQueue,
  signedWebhook,
  subscriptionWebhook,
  useFakePaymentProvider,
} from '#tests/helpers'

/**
 * The webhook endpoint and the handler behind it (plan §7.5, §15).
 *
 * The endpoint's contract is narrow on purpose — verify, record, dispatch,
 * 200 — so most of what matters here is what it *refuses* and what it does
 * exactly once.
 */
test.group('Webhooks — the endpoint', (group) => {
  group.each.setup(() => {
    mail.fake()
    useFakePaymentProvider()

    return () => {
      mail.restore()
      restorePaymentProvider()
    }
  })
  group.each.setup(() => testUtils.db().truncate())

  const post = (client: any, body: Record<string, any>) => {
    const { headers } = signedWebhook(body)

    return client.post('/webhooks/creem').redirects(0).headers(headers).json(body)
  }

  test('accepts a signed delivery, records it and queues the work', async ({ client, assert }) => {
    const { organization } = await createWorkspace()

    const response = await post(
      client,
      subscriptionWebhook({ organizationPublicId: organization.publicId })
    )

    response.assertStatus(200)

    const ledger = await WebhookEvent.query().firstOrFail()
    assert.equal(ledger.eventType, 'subscription.activated')
    assert.isTrue(ledger.signatureVerified)
    assert.isNull(ledger.processedAt, 'the endpoint records, the worker applies')

    const jobs = await Job.query().where('name', 'process_webhook')
    assert.lengthOf(jobs, 1)
  })

  /**
   * The whole reason for the unique index on `provider_event_id`: Creem
   * retries five times, and a retry must cost nothing.
   */
  test('a redelivery is a 200 and changes nothing', async ({ client, assert }) => {
    const { organization } = await createWorkspace()
    const body = subscriptionWebhook({ organizationPublicId: organization.publicId })

    await post(client, body)
    const second = await post(client, body)

    second.assertStatus(200)
    second.assertBodyContains({ duplicate: true })

    assert.lengthOf(await WebhookEvent.all(), 1)
    assert.lengthOf(await Job.query().where('name', 'process_webhook'), 1)
  })

  /**
   * An unsigned body is somebody claiming an upgrade happened.
   */
  test('refuses an unsigned body', async ({ client, assert }) => {
    const response = await client.post('/webhooks/creem').redirects(0).json(subscriptionWebhook({}))

    response.assertStatus(401)
    assert.lengthOf(await WebhookEvent.all(), 0)
  })

  test('refuses a body whose signature does not match it', async ({ client, assert }) => {
    const { body, headers } = signedWebhook(subscriptionWebhook({ subscriptionId: 'sub_a' }))

    /**
     * Signed as `sub_a`, delivered as `sub_b` — the exact shape of a replayed
     * webhook with the amount edited.
     */
    body.object.id = 'sub_b'

    const response = await client.post('/webhooks/creem').redirects(0).headers(headers).json(body)

    response.assertStatus(401)
    assert.lengthOf(await WebhookEvent.all(), 0)
  })

  /**
   * A signed event we have no mapping for is a change at Creem. 200, because
   * retrying will not make us understand it, and a log line instead.
   */
  test('a signed event we cannot parse is acknowledged but not recorded', async ({
    client,
    assert,
  }) => {
    const response = await post(client, {
      id: 'evt_new',
      eventType: 'subscription.something_creem_added',
      object: {},
    })

    response.assertStatus(200)
    response.assertBodyContains({ applied: false })
    assert.lengthOf(await WebhookEvent.all(), 0)
  })

  test('CSRF does not apply — there is no browser on the other end', async ({ client }) => {
    const { organization } = await createWorkspace()

    /**
     * No `withCsrfToken()` anywhere in this file. If shield were enforcing
     * here, every test above would already be a 403.
     */
    const response = await post(
      client,
      subscriptionWebhook({ organizationPublicId: organization.publicId })
    )

    response.assertStatus(200)
  })
})

test.group('Webhooks — applying an event', (group) => {
  group.each.setup(() => {
    mail.fake()
    useFakePaymentProvider()

    return () => {
      mail.restore()
      restorePaymentProvider()
    }
  })
  group.each.setup(() => testUtils.db().truncate())

  const deliver = async (client: any, body: Record<string, any>) => {
    const { headers } = signedWebhook(body)

    await client.post('/webhooks/creem').redirects(0).headers(headers).json(body)

    /**
     * Drain both queues: the webhook lands on `default`, and the emails it
     * produces land on `mail`.
     */
    await runQueue('default')

    return WebhookEvent.query().orderBy('id', 'desc').firstOrFail()
  }

  /**
   * A subscription on the licensing path, with a checkout of ours behind it.
   */
  async function subscribed(client: any, createdAt?: string) {
    const { plan } = await createSellablePlan({ billing: 'yearly', licenseTerm: 'subscription' })
    const { order } = await orders.startCheckout({
      plan,
      email: 'owner@example.com',
      successUrl: 'https://example.com/thanks',
    })

    const ledger = await deliver(
      client,
      creemLicensing.subscription({
        orderPublicId: order.publicId,
        productId: plan.providerProductId!,
        createdAt,
      })
    )

    return { plan, order, ledger }
  }

  test('an activation records the subscription and issues its license', async ({
    client,
    assert,
  }) => {
    const { ledger, plan } = await subscribed(client)

    assert.isNotNull(ledger.processedAt)

    const subscription = await Subscription.query().firstOrFail()
    assert.equal(subscription.planId, plan.id)
    assert.equal(subscription.status, 'active')
    assert.equal(subscription.providerCustomerId, 'cus_test_1')
    assert.lengthOf(await License.all(), 1)
  })

  /**
   * The tenant is found through the order id we put in the checkout
   * metadata, or a catalog plan mapped to the product — nothing else. A
   * subscription for a product we do not sell is parked, not guessed at.
   */
  test('a subscription that maps to nothing we sell is parked', async ({ client, assert }) => {
    await createWorkspace()

    const ledger = await deliver(client, subscriptionWebhook({}))

    assert.isNull(ledger.processedAt, 'never marked done')
    assert.match(ledger.lastError ?? '', /maps to no catalog plan/)
    assert.lengthOf(await Subscription.all(), 0)
  })

  test('a second delivery of the same subscription updates one row', async ({ client, assert }) => {
    const { plan } = await subscribed(client)

    await deliver(
      client,
      creemLicensing.subscription({
        eventType: 'subscription.past_due',
        productId: plan.providerProductId!,
        status: 'past_due',
      })
    )

    assert.lengthOf(await Subscription.all(), 1)

    const subscription = await Subscription.query().firstOrFail()
    assert.equal(subscription.status, 'past_due')
  })

  /**
   * Webhooks arrive out of order. A late `past_due` must not undo the
   * `active` that superseded it (plan §7.5).
   */
  test('an event older than what the row already knows is ignored', async ({ client, assert }) => {
    const { plan } = await subscribed(client, '2026-09-07T12:00:00.000Z')

    await deliver(
      client,
      creemLicensing.subscription({
        eventType: 'subscription.past_due',
        productId: plan.providerProductId!,
        status: 'past_due',
        createdAt: '2020-01-01T00:00:00.000Z',
      })
    )

    const subscription = await Subscription.query().firstOrFail()
    assert.equal(subscription.status, 'active', 'the stale event did not win')
  })

  /**
   * One email on the transition to past due, never one per redelivery.
   */
  test('a failed renewal emails the owner once', async ({ client, assert }) => {
    const { plan } = await subscribed(client)
    const pastDue = {
      eventType: 'subscription.past_due',
      productId: plan.providerProductId!,
      status: 'past_due',
    }

    await deliver(client, creemLicensing.subscription(pastDue))
    await deliver(client, creemLicensing.subscription(pastDue))

    const mails = await queuedMailsTo('owner@example.com')
    const failed = mails.filter((message) => message.subject.includes('could not renew'))
    assert.lengthOf(failed, 1)
  })

  test('a payment is recorded once and emails one receipt', async ({ client, assert }) => {
    const { plan } = await createSellablePlan()
    const { order } = await orders.startCheckout({
      plan,
      email: 'owner@example.com',
      successUrl: 'https://example.com/thanks',
    })

    const body = creemLicensing.oneTimeCheckout({
      orderPublicId: order.publicId,
      providerOrderId: 'ord_1',
      amountCents: 2900,
    })

    await deliver(client, body)
    await deliver(client, { ...body, id: 'evt_redelivered' })

    const payments = await Payment.all()
    assert.lengthOf(payments, 1)
    assert.equal(payments[0].amountCents, 2900)
    assert.equal(payments[0].currency, 'EUR')
    assert.equal(payments[0].status, 'succeeded')
    assert.match(payments[0].publicId, /^pay_/)

    const queued = await queuedMailsTo('owner@example.com')
    const receipts = queued.filter((message) => message.subject.includes('payment'))
    assert.lengthOf(receipts, 1, 'one charge, one receipt')
  })

  test('a refund grows the original row rather than writing a second one', async ({
    client,
    assert,
  }) => {
    const { plan } = await createSellablePlan()
    const { order } = await orders.startCheckout({
      plan,
      email: 'owner@example.com',
      successUrl: 'https://example.com/thanks',
    })

    await deliver(
      client,
      creemLicensing.oneTimeCheckout({
        orderPublicId: order.publicId,
        providerOrderId: 'ord_1',
        amountCents: 2900,
      })
    )
    await deliver(client, creemLicensing.refund({ providerOrderId: 'ord_1', amountCents: 1000 }))

    const payments = await Payment.all()
    assert.lengthOf(payments, 1, 'one order, one row')
    assert.equal(payments[0].amountCents, 2900)
    assert.equal(payments[0].refundedAmountCents, 1000)
    assert.equal(payments[0].status, 'partially_refunded')
    assert.equal(payments[0].netAmountCents, 1900)
  })

  test('a dispute marks the payment and leaves the account alone', async ({ client, assert }) => {
    const { plan } = await createSellablePlan()
    const { order } = await orders.startCheckout({
      plan,
      email: 'owner@example.com',
      successUrl: 'https://example.com/thanks',
    })

    await deliver(
      client,
      creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId, providerOrderId: 'ord_1' })
    )
    await deliver(client, creemLicensing.dispute({ providerOrderId: 'ord_1' }))

    const payment = await Payment.query().firstOrFail()
    assert.equal(payment.status, 'disputed')

    await order.refresh()
    const organization = await Organization.findOrFail(order.organizationId)
    assert.equal(organization.status, 'active', 'suspending an account is a human decision')
  })

  /**
   * The worker's own idempotency, independent of the endpoint's: a job that
   * runs twice must leave the same rows (plan §9).
   */
  test('applying the same stored event twice changes nothing', async ({ client, assert }) => {
    const { ledger } = await subscribed(client)

    const { default: webhooks } = await import('#billing/webhook_handler')
    const { paymentProvider } = await import('#billing/provider')

    await webhooks.apply(
      paymentProvider().parseWebhook(Buffer.from(JSON.stringify(ledger.payload)))
    )

    assert.lengthOf(await Subscription.all(), 1)
    assert.lengthOf(await License.all(), 1)
  })
})
