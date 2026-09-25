import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import mail from '@adonisjs/mail/services/main'
import testUtils from '@adonisjs/core/services/test_utils'

import Payment from '#models/payment'
import Subscription from '#models/subscription'
import type Organization from '#models/organization'
import billing, { BillingError } from '#billing/billing_service'
import {
  addMember,
  createCatalogPlan,
  createWorkspace,
  restorePaymentProvider,
  useFakePaymentProvider,
  type FakePaymentProvider,
} from '#tests/helpers'

/**
 * A live license subscription for an account, written the way a webhook
 * would have written it.
 */
async function subscribe(organization: Organization) {
  const { plan } = await createCatalogPlan({
    product: { name: 'Invoice Pro' },
    plan: { name: 'Yearly', billing: 'yearly', licenseTerm: 'subscription', priceCents: 14_900 },
  })

  return Subscription.create({
    organizationId: organization.id,
    provider: 'creem',
    providerSubscriptionId: 'sub_live_1',
    providerCustomerId: 'cus_live_1',
    planKey: 'license',
    planId: plan.id,
    status: 'active',
    currentPeriodStart: DateTime.utc().startOf('month'),
    currentPeriodEnd: DateTime.utc().startOf('month').plus({ years: 1 }),
    cancelAtPeriodEnd: false,
  })
}

test.group('Billing screen', (group) => {
  group.each.setup(() => {
    mail.fake()
    useFakePaymentProvider()

    return () => {
      mail.restore()
      restorePaymentProvider()
    }
  })
  group.each.setup(() => testUtils.db().truncate())

  /**
   * Billing is owner-only (plan §6) — a member does not see the screen at
   * all, rather than seeing it with every button refused.
   */
  test('a member cannot reach billing', async ({ client }) => {
    const { user, organization } = await createWorkspace()
    const member = await addMember(organization, user, 'sam@example.com')

    const response = await client.get('/billing').loginAs(member).redirects(0)

    response.assertStatus(302)
    response.assertFlashMessage('error', 'Only the workspace owner can do that.')
  })

  test('the owner sees an empty record before buying anything', async ({ client, assert }) => {
    const { user } = await createWorkspace()

    const response = await client.get('/billing').loginAs(user)

    response.assertStatus(200)
    response.assertTextIncludes('No subscriptions')
    response.assertTextIncludes('No orders yet')
    response.assertTextIncludes('No transactions yet')

    /**
     * Nothing is sold here any more — no tier grid, no checkout buttons.
     */
    assert.notInclude(response.text(), 'Switch to')
    assert.notInclude(response.text(), 'Manage payment')
  })

  test('shows the subscription and the charges behind it', async ({ client }) => {
    const { user, organization } = await createWorkspace()
    const subscription = await subscribe(organization)

    await Payment.create({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      provider: 'creem',
      providerOrderId: 'ord_1',
      amountCents: 14_900,
      currency: 'EUR',
      status: 'succeeded',
      refundedAmountCents: 0,
      description: 'Invoice Pro · Yearly',
      occurredAt: DateTime.utc(),
    })

    const response = await client.get('/billing').loginAs(user)

    response.assertStatus(200)
    response.assertTextIncludes('Invoice Pro · Yearly')
    response.assertTextIncludes('Active')
    response.assertTextIncludes('Paid')

    /* The portal button appears once there is a subscription to manage. */
    response.assertTextIncludes('Manage payment')
  })
})

test.group('Billing — the provider portal', (group) => {
  let provider: FakePaymentProvider

  group.each.setup(() => {
    mail.fake()
    provider = useFakePaymentProvider()

    return () => {
      mail.restore()
      restorePaymentProvider()
    }
  })
  group.each.setup(() => testUtils.db().truncate())

  test('sends the owner to the provider rather than rebuilding card handling', async ({
    client,
    assert,
  }) => {
    const { user, organization } = await createWorkspace()
    await subscribe(organization)

    const response = await client.post('/billing/portal').loginAs(user).withCsrfToken().redirects(0)

    response.assertStatus(302)
    response.assertHeader('location', 'https://portal.test/cus_live_1')

    assert.equal(provider.portals[0].customerId, 'cus_live_1')
  })

  test('says so plainly when there is nothing to manage', async ({ assert }) => {
    const { organization } = await createWorkspace()

    await assert.rejects(
      () => billing.startPortal(organization),
      'There is no subscription to manage. One-time purchases have nothing to cancel.'
    )
  })

  /**
   * A subscription recorded before the provider told us who the customer was
   * is recoverable by asking, rather than by showing the owner a dead button.
   */
  test('re-fetches a missing customer id instead of failing', async ({ assert }) => {
    const { organization } = await createWorkspace()
    const subscription = await subscribe(organization)

    subscription.providerCustomerId = null
    await subscription.save()

    provider.subscriptions.set('sub_live_1', {
      id: 'sub_live_1',
      customerId: 'cus_recovered',
      productId: 'prod_x',
      status: 'active',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEndsAt: null,
      canceledAt: null,
    })

    const { url } = await billing.startPortal(organization)

    assert.equal(url, 'https://portal.test/cus_recovered')

    await subscription.refresh()
    assert.equal(subscription.providerCustomerId, 'cus_recovered', 'and remembered for next time')
  })

  test('gives up gracefully when the provider has no customer either', async ({ assert }) => {
    const { organization } = await createWorkspace()
    const subscription = await subscribe(organization)

    subscription.providerCustomerId = null
    await subscription.save()

    try {
      await billing.startPortal(organization)
      assert.fail('should have refused')
    } catch (error) {
      assert.instanceOf(error, BillingError)
      assert.equal((error as BillingError).reason, 'no_customer')
    }
  })
})

/**
 * The account-state banner (plan §7.5, §13.5). A `past_due` workspace stays
 * fully usable — the banner is how the owner finds out before the period ends.
 */
test.group('Billing — the past_due banner', (group) => {
  group.each.setup(() => {
    mail.fake()
    useFakePaymentProvider()

    return () => {
      mail.restore()
      restorePaymentProvider()
    }
  })
  group.each.setup(() => testUtils.db().truncate())

  test('shows on every screen and says nothing was switched off', async ({ client }) => {
    const { user, organization } = await createWorkspace()

    organization.status = 'past_due'
    await organization.save()

    const response = await client.get('/dashboard').loginAs(user)

    response.assertStatus(200)
    response.assertTextIncludes('We could not take payment')
    response.assertTextIncludes('Nothing has been switched off yet')
  })

  test('a past_due account can still see its licenses', async ({ client }) => {
    const { user, organization } = await createWorkspace()

    organization.status = 'past_due'
    await organization.save()

    const response = await client.get('/licenses').loginAs(user)

    response.assertStatus(200)
  })
})
