import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import mail from '@adonisjs/mail/services/main'
import testUtils from '@adonisjs/core/services/test_utils'

import Job from '#models/job'
import Payment from '#models/payment'
import Receipt from '#models/receipt'
import Subscription from '#models/subscription'
import Organization from '#models/organization'
import orders from '#commerce/order_service'
import receipts from '#billing/receipt_service'
import storage from '#storage/disk_storage'
import {
  addMember,
  clearStorage,
  createCatalogPlan,
  createSellablePlan,
  createStaff,
  createWorkspace,
  creemLicensing,
  restorePaymentProvider,
  runQueue,
  signedWebhook,
  useFakePaymentProvider,
} from '#tests/helpers'

/**
 * Receipts (licence plan M9): a numbered PDF per successful charge, issued
 * when the payment lands, attached to the receipt email, and downloadable
 * from the portal and the back-office for as long as the account exists.
 */
test.group('Receipts', (group) => {
  group.each.setup(() => {
    mail.fake()
    useFakePaymentProvider()

    return async () => {
      mail.restore()
      restorePaymentProvider()
      await clearStorage()
    }
  })
  group.each.setup(() => testUtils.db().truncate())

  const deliver = async (client: any, body: Record<string, any>) => {
    const { headers } = signedWebhook(body)
    await client.post('/webhooks/creem').redirects(0).headers(headers).json(body)
    await runQueue('default')
  }

  /**
   * A one-time purchase, paid: the order, its payment and the account the
   * webhook created for the buyer.
   */
  async function purchased(client: any, chargedLess = 0) {
    const { plan } = await createSellablePlan({ name: 'Lifetime', slug: 'lifetime' })
    const amountCents = plan.priceCents - chargedLess
    const { order } = await orders.startCheckout({
      plan,
      email: 'buyer@example.com',
      successUrl: 'https://example.com/thanks',
    })

    await deliver(
      client,
      creemLicensing.oneTimeCheckout({
        orderPublicId: order.publicId,
        providerOrderId: 'ord_1',
        amountCents,
      })
    )

    const payment = await Payment.query().firstOrFail()
    const organization = await Organization.findOrFail(payment.organizationId)
    /**
     * The webhook made the account without a password or a verified
     * address; the portal's screens want the latter.
     */
    const { default: User } = await import('#models/user')
    const owner = await User.findByOrFail('email', 'buyer@example.com')
    owner.emailVerifiedAt = DateTime.utc()
    await owner.save()

    return { plan, order, payment, organization, owner, amountCents }
  }

  test('a paid checkout issues a numbered receipt and attaches it to the email', async ({
    client,
    assert,
  }) => {
    const { payment, organization, amountCents } = await purchased(client)

    const receipt = await Receipt.query().firstOrFail()
    assert.equal(receipt.paymentId, payment.id)
    assert.equal(receipt.organizationId, organization.id)
    assert.match(receipt.number, /^R-\d{4}-000001$/)
    assert.match(receipt.publicId, /^rcp_/)
    assert.equal(receipt.amountCents, amountCents)
    assert.equal(receipt.currency, 'EUR')
    assert.isTrue(await storage.exists({ disk: 'private', key: receipt.storageKey }))

    const jobs = await Job.query().where('name', 'send_mail')
    const receiptMail = jobs
      .map((job) => (job.payload as any).compiled.message)
      .find((message) => String(message.subject).includes('payment'))

    assert.exists(receiptMail, 'the receipt email was queued')
    assert.lengthOf(receiptMail.attachments, 1)
    assert.equal(receiptMail.attachments[0].filename, `receipt-${receipt.number}.pdf`)
    assert.equal(receiptMail.attachments[0].contentType, 'application/pdf')
    assert.equal(receiptMail.attachments[0].encoding, 'base64')
    assert.equal(
      Buffer.from(receiptMail.attachments[0].content, 'base64').subarray(0, 5).toString(),
      '%PDF-'
    )
    assert.include(receiptMail.html, receipt.number)
    assert.include(receiptMail.html, `/billing/receipts/${payment.publicId}`)
  })

  test('says what was bought, who paid, and who the merchant of record is', async ({
    client,
    assert,
  }) => {
    const { payment, organization, amountCents } = await purchased(client)
    const receipt = await Receipt.query().firstOrFail()

    const content = await receipts.content(receipt, payment, organization)

    assert.deepEqual(content.lines, [
      { description: 'Invoice Pro · Lifetime', quantity: 1, unitCents: amountCents },
    ])
    assert.equal(content.totalCents, amountCents)
    assert.equal(content.currency, 'EUR')
    assert.equal(content.billedTo.email, 'buyer@example.com')
    assert.equal(content.billedTo.name, organization.name)
    assert.equal(content.paymentReference, 'ord_1')
    assert.include(content.note, 'merchant of record')
  })

  test('a charge that differs from its lines gets an adjustment line, never a wrong total', async ({
    client,
    assert,
  }) => {
    const { payment, organization, amountCents } = await purchased(client, 400)
    const receipt = await Receipt.query().firstOrFail()

    const content = await receipts.content(receipt, payment, organization)

    assert.equal(content.totalCents, amountCents)
    assert.deepEqual(content.lines[1], { description: 'Adjustment', quantity: 1, unitCents: -400 })
  })

  test('a redelivered payment and a refund do not issue a second receipt', async ({
    client,
    assert,
  }) => {
    const { order, amountCents } = await purchased(client)

    await deliver(
      client,
      creemLicensing.oneTimeCheckout({
        orderPublicId: order.publicId,
        providerOrderId: 'ord_1',
        amountCents,
        eventId: 'evt_again',
      })
    )
    await deliver(client, creemLicensing.refund({ providerOrderId: 'ord_1', amountCents }))

    const all = await Receipt.all()
    assert.lengthOf(all, 1)
    assert.equal(all[0].amountCents, amountCents, 'the receipt records the charge as it was')
  })

  test('the owner downloads it; a member cannot reach billing at all', async ({
    client,
    assert,
  }) => {
    const { payment, organization, owner } = await purchased(client)
    const receipt = await Receipt.query().firstOrFail()

    const response = await client.get(`/billing/receipts/${payment.publicId}`).loginAs(owner)

    response.assertStatus(200)
    response.assertHeader('content-type', 'application/pdf')
    response.assertHeader(
      'content-disposition',
      `attachment; filename="receipt-${receipt.number}.pdf"`
    )
    assert.equal(response.response.body.subarray(0, 5).toString(), '%PDF-')

    const member = await addMember(organization, owner, 'sam@example.com')
    const refused = await client
      .get(`/billing/receipts/${payment.publicId}`)
      .loginAs(member)
      .redirects(0)
    refused.assertStatus(302)
  })

  test('the billing screen links every charge to its receipt', async ({ client }) => {
    const { payment, owner } = await purchased(client)

    const response = await client.get('/billing').loginAs(owner)

    response.assertStatus(200)
    response.assertTextIncludes(`/billing/receipts/${payment.publicId}`)
  })

  test('a charge from before receipts existed gets one on its first download', async ({
    client,
    assert,
  }) => {
    const { user, organization } = await createWorkspace()
    const payment = await Payment.create({
      organizationId: organization.id,
      provider: 'creem',
      providerOrderId: 'ord_old',
      amountCents: 9900,
      currency: 'USD',
      status: 'succeeded',
      description: 'Invoice Pro',
      occurredAt: DateTime.utc().minus({ months: 3 }),
    })
    assert.lengthOf(await Receipt.all(), 0)

    const response = await client.get(`/billing/receipts/${payment.publicId}`).loginAs(user)

    response.assertStatus(200)
    const receipt = await Receipt.query().firstOrFail()
    assert.equal(receipt.paymentId, payment.id)
    assert.equal(receipt.amountCents, 9900)

    const content = await receipts.content(receipt, payment, organization)
    assert.deepEqual(content.lines, [{ description: 'Invoice Pro', quantity: 1, unitCents: 9900 }])
    assert.equal(content.billedTo.email, user.email)
  })

  test('a renewal is described by its subscription', async ({ assert }) => {
    const { organization } = await createWorkspace()
    const { plan } = await createCatalogPlan({
      product: { name: 'Invoice Pro' },
      plan: { name: 'Yearly', billing: 'yearly', licenseTerm: 'subscription', priceCents: 14_900 },
    })
    const subscription = await Subscription.create({
      organizationId: organization.id,
      provider: 'creem',
      providerSubscriptionId: 'sub_1',
      providerCustomerId: 'cus_1',
      planKey: 'license',
      planId: plan.id,
      status: 'active',
      currentPeriodStart: DateTime.utc().startOf('month'),
      currentPeriodEnd: DateTime.utc().startOf('month').plus({ years: 1 }),
      cancelAtPeriodEnd: false,
    })
    const payment = await Payment.create({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      provider: 'creem',
      providerOrderId: 'ord_renewal',
      amountCents: 14_900,
      currency: 'EUR',
      status: 'succeeded',
      occurredAt: DateTime.utc(),
    })

    const receipt = await receipts.issue(payment)
    const content = await receipts.content(receipt, payment, organization)

    assert.deepEqual(content.lines, [
      { description: 'Invoice Pro · Yearly — renewal', quantity: 1, unitCents: 14_900 },
    ])
  })

  test('the PDF is drawn again when storage has lost it', async ({ client, assert }) => {
    const { payment, owner } = await purchased(client)
    const receipt = await Receipt.query().firstOrFail()

    await storage.delete({ disk: 'private', key: receipt.storageKey })
    assert.isFalse(await storage.exists({ disk: 'private', key: receipt.storageKey }))

    const response = await client.get(`/billing/receipts/${payment.publicId}`).loginAs(owner)

    response.assertStatus(200)
    assert.isTrue(await storage.exists({ disk: 'private', key: receipt.storageKey }))
  })

  test('numbers keep counting across receipts', async ({ client, assert }) => {
    const { organization } = await purchased(client)
    const second = await Payment.create({
      organizationId: organization.id,
      provider: 'creem',
      providerOrderId: 'ord_2',
      amountCents: 100,
      currency: 'EUR',
      status: 'succeeded',
      occurredAt: DateTime.utc(),
    })

    const receipt = await receipts.issue(second)

    assert.match(receipt.number, /^R-\d{4}-000002$/)
  })

  test('support downloads it from the back-office', async ({ client, assert }) => {
    const { payment } = await purchased(client)
    const support = await createStaff({ role: 'support' })

    const response = await client
      .get(`/admin/payments/${payment.publicId}/receipt`)
      .withGuard('staff')
      .loginAs(support)

    response.assertStatus(200)
    response.assertHeader('content-type', 'application/pdf')
    assert.equal(response.response.body.subarray(0, 5).toString(), '%PDF-')
  })
})
