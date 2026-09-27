import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import mail from '@adonisjs/mail/services/main'
import testUtils from '@adonisjs/core/services/test_utils'

import Subscription from '#models/subscription'
import type Organization from '#models/organization'
import reconciliation from '#billing/reconciliation'
import type { ProviderSubscription } from '#billing/contracts'
import License from '#models/license'
import licensingConfig from '#config/licensing'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'
import {
  createCatalogPlan,
  createWorkspace,
  restorePaymentProvider,
  useFakePaymentProvider,
  type FakePaymentProvider,
} from '#tests/helpers'

const theirs = (overrides: Partial<ProviderSubscription> = {}): ProviderSubscription => ({
  id: 'sub_1',
  customerId: 'cus_1',
  productId: 'prod_test_pro',
  status: 'active',
  currentPeriodStart: DateTime.fromISO('2026-09-01T00:00:00.000Z', { zone: 'utc' }),
  currentPeriodEnd: DateTime.fromISO('2026-10-01T00:00:00.000Z', { zone: 'utc' }),
  cancelAtPeriodEnd: false,
  trialEndsAt: null,
  canceledAt: null,
  ...overrides,
})

/**
 * A license subscription as the webhook would have left it, with the license
 * it keeps alive — mapped to `prod_test_pro`, which is what `theirs()` names,
 * so a fresh pair agrees about the plan.
 */
async function localSubscription(organization: Organization, overrides: Record<string, any> = {}) {
  const { product, plan } = await createCatalogPlan({
    plan: {
      billing: 'yearly',
      licenseTerm: 'subscription',
      providerProductId: 'prod_test_pro',
    },
  })

  const subscription = await Subscription.create({
    organizationId: organization.id,
    provider: 'creem',
    providerSubscriptionId: 'sub_1',
    providerCustomerId: 'cus_1',
    planKey: 'license',
    planId: plan.id,
    status: 'active',
    currentPeriodStart: DateTime.fromISO('2026-09-01T00:00:00.000Z', { zone: 'utc' }),
    currentPeriodEnd: DateTime.fromISO('2026-10-01T00:00:00.000Z', { zone: 'utc' }),
    cancelAtPeriodEnd: false,
    ...overrides,
  })

  const { license } = await licenses.issue({
    organization,
    plan,
    source: 'order',
    actor: SYSTEM_ACTOR,
    subscriptionId: subscription.id,
    /**
     * What the webhook would have set: the period end plus the renewal grace.
     */
    expiresAt: subscription.currentPeriodEnd
      ? subscription.currentPeriodEnd.plus({ days: licensingConfig.renewalGraceDays })
      : DateTime.utc().plus({ days: 10 }),
  })

  return { subscription, license, product }
}

/**
 * Reconciliation (plan §7.5).
 *
 * The sweep that catches a webhook that never arrived — a bad deploy, an
 * endpoint that 500s past Creem's five retries — which otherwise leaves a
 * customer on the wrong plan silently and forever.
 */
test.group('Reconciliation', (group) => {
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

  test('reports nothing when local and provider agree', async ({ assert }) => {
    const { organization } = await createWorkspace()
    await localSubscription(organization)

    provider.subscriptions.set('sub_1', theirs())

    const report = await reconciliation.reconcile()

    assert.equal(report.checked, 1)
    assert.isEmpty(report.drifted)
    assert.isEmpty(report.missing)
    assert.equal(report.corrected, 0)
  })

  /**
   * The case this exists for: the provider cancelled and we never heard.
   * Leaving the customer on a plan they stopped paying for costs money, so
   * this one *is* corrected rather than only reported.
   */
  test('corrects a status the provider disagrees with, and the license follows', async ({
    assert,
  }) => {
    const { organization } = await createWorkspace()
    const { license, product } = await localSubscription(organization)

    provider.subscriptions.set('sub_1', theirs({ status: 'canceled' }))

    const report = await reconciliation.reconcile()

    assert.lengthOf(report.drifted, 1)
    assert.equal(report.drifted[0].field, 'status')
    assert.equal(report.corrected, 1)

    const subscription = await Subscription.query().firstOrFail()
    assert.equal(subscription.status, 'canceled')

    const { result } = await licenses.check(license.keyEncrypted, product.slug)
    assert.equal(result.reason, 'subscription_inactive', 'the license followed the status')
  })

  test('the reverse too — a customer who is paying keeps a working license', async ({ assert }) => {
    const { organization } = await createWorkspace()
    const { license, product } = await localSubscription(organization, { status: 'paused' })

    provider.subscriptions.set('sub_1', theirs({ status: 'active' }))

    await reconciliation.reconcile()

    const { result } = await licenses.check(license.keyEncrypted, product.slug)
    assert.isTrue(result.valid)

    /**
     * And its expiry is re-derived from the period we have: the period end
     * plus the renewal grace.
     */
    const refreshed = await License.findOrFail(license.id)
    assert.equal(
      refreshed.expiresAt!.toMillis(),
      DateTime.fromISO('2026-10-01T00:00:00.000Z', { zone: 'utc' })
        .plus({ days: licensingConfig.renewalGraceDays })
        .toMillis()
    )
  })

  /**
   * Licence plan M8: a later period on a renewing subscription is a renewal
   * whose webhook never arrived. Left alone, the customer who paid loses the
   * license 30 days after the old period — so it is corrected.
   */
  test('adopts a later period, and the license moves with it', async ({ assert }) => {
    const { organization } = await createWorkspace()
    const { license } = await localSubscription(organization)
    const renewedTo = DateTime.fromISO('2027-10-01T00:00:00.000Z', { zone: 'utc' })

    provider.subscriptions.set('sub_1', theirs({ currentPeriodEnd: renewedTo }))

    const report = await reconciliation.reconcile()

    assert.equal(report.drifted[0].field, 'currentPeriodEnd', 'still reported')
    assert.equal(report.corrected, 1)

    const subscription = await Subscription.query().firstOrFail()
    assert.equal(subscription.currentPeriodEnd?.toMillis(), renewedTo.toMillis())

    await license.refresh()
    assert.equal(
      license.expiresAt!.toMillis(),
      renewedTo.plus({ days: licensingConfig.renewalGraceDays }).toMillis()
    )
  })

  /**
   * Everything that could cut somebody short is reported and left alone:
   * a job that quietly shortens licenses on the provider's word, with nobody
   * looking, is worse than the drift.
   */
  test('reports an earlier period without rewriting it', async ({ assert }) => {
    const { organization } = await createWorkspace()
    const { license } = await localSubscription(organization)
    const before = license.expiresAt!.toMillis()

    provider.subscriptions.set(
      'sub_1',
      theirs({ currentPeriodEnd: DateTime.fromISO('2026-09-15T00:00:00.000Z', { zone: 'utc' }) })
    )

    const report = await reconciliation.reconcile()

    assert.lengthOf(report.drifted, 1)
    assert.equal(report.drifted[0].field, 'currentPeriodEnd')
    assert.equal(report.corrected, 0)

    const subscription = await Subscription.query().firstOrFail()
    assert.equal(subscription.currentPeriodEnd?.toUTC().toISO(), '2026-10-01T00:00:00.000Z')
    await license.refresh()
    assert.equal(license.expiresAt!.toMillis(), before)
  })

  test('a later period on a cancelled subscription is not adopted', async ({ assert }) => {
    const { organization } = await createWorkspace()
    await localSubscription(organization, { cancelAtPeriodEnd: true })

    provider.subscriptions.set(
      'sub_1',
      theirs({
        status: 'canceled',
        currentPeriodEnd: DateTime.fromISO('2027-10-01T00:00:00.000Z', { zone: 'utc' }),
      })
    )

    await reconciliation.reconcile()

    const subscription = await Subscription.query().firstOrFail()
    assert.equal(subscription.currentPeriodEnd?.toUTC().toISO(), '2026-10-01T00:00:00.000Z')
  })

  test('a license that would expire before its subscription says is moved out', async ({
    assert,
  }) => {
    const { organization } = await createWorkspace()
    const { license } = await localSubscription(organization)
    license.expiresAt = DateTime.utc().plus({ days: 3 })
    await license.save()

    provider.subscriptions.set('sub_1', theirs())

    const report = await reconciliation.reconcile()

    assert.equal(report.corrected, 1)
    await license.refresh()
    assert.equal(
      license.expiresAt!.toUTC().toISO(),
      DateTime.fromISO('2026-10-01T00:00:00.000Z', { zone: 'utc' })
        .plus({ days: licensingConfig.renewalGraceDays })
        .toUTC()
        .toISO()
    )
  })

  test('a license staff extended past its subscription is reported, not shortened', async ({
    assert,
  }) => {
    const { organization } = await createWorkspace()
    const { license } = await localSubscription(organization)
    const extended = DateTime.utc().plus({ years: 3 }).set({ millisecond: 0 })
    license.expiresAt = extended
    await license.save()

    provider.subscriptions.set('sub_1', theirs())

    const report = await reconciliation.reconcile()

    assert.lengthOf(report.drifted, 1)
    assert.match(report.drifted[0].field, /^license lic_\w+ expiresAt$/)
    assert.equal(report.corrected, 0)
    await license.refresh()
    assert.equal(license.expiresAt!.toMillis(), extended.toMillis())
  })

  test('a subscription the provider has never heard of is reported, never deleted', async ({
    assert,
  }) => {
    const { organization } = await createWorkspace()
    await localSubscription(organization)

    const report = await reconciliation.reconcile()

    assert.lengthOf(report.missing, 1)
    assert.lengthOf(await Subscription.all(), 1, 'the row stays for a human to look at')
  })

  /**
   * Terminal subscriptions cost a network call each and can never change.
   */
  test('skips cancelled and expired subscriptions', async ({ assert }) => {
    const { organization } = await createWorkspace()
    await localSubscription(organization, { status: 'canceled' })

    const report = await reconciliation.reconcile()

    assert.equal(report.checked, 0)
  })

  test('a dry run reports the same drift and changes nothing', async ({ assert }) => {
    const { organization } = await createWorkspace()
    await localSubscription(organization)

    provider.subscriptions.set('sub_1', theirs({ status: 'canceled' }))

    const report = await reconciliation.diff()

    assert.lengthOf(report.drifted, 1)
    assert.equal(report.corrected, 0)

    const subscription = await Subscription.query().firstOrFail()
    assert.equal(subscription.status, 'active', 'untouched')
  })
})
