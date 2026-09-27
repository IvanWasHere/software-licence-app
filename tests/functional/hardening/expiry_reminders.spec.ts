import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import testUtils from '@adonisjs/core/services/test_utils'

import Subscription from '#models/subscription'
import LicenseEvent from '#models/license_event'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'
import remindersJob from '#queue/jobs/license_expiry_reminders_job'
import { createLicense, createWorkspace, queuedMails, queuedMailsTo } from '#tests/helpers'

/**
 * The expiry reminder job (licence plan §5.5, M8), against real rows.
 */
async function expiringIn(days: number, subscription?: Partial<Subscription>) {
  const { user, organization } = await createWorkspace()
  const created = await createLicense({
    organization,
    plan: { licenseTerm: 'fixed_days', termDays: 365, billing: 'one_time' },
    expiresAt: DateTime.utc().plus({ days: 30 }),
  })

  /**
   * Set afterwards: issuing refuses an expiry in the past.
   */
  created.license.expiresAt = DateTime.utc().plus({ days })
  await created.license.save()

  if (subscription) {
    const row = await Subscription.create({
      organizationId: organization.id,
      planId: created.plan.id,
      planKey: 'license',
      provider: 'creem',
      providerSubscriptionId: `sub_${Math.random().toString(36).slice(2)}`,
      status: 'active',
      cancelAtPeriodEnd: false,
      ...subscription,
    })
    created.license.subscriptionId = row.id
    await created.license.save()
  }

  return { ...created, user }
}

test.group('Expiry reminders', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('emails the owner of a license two weeks from expiry, once', async ({ assert }) => {
    const { user, product, license } = await expiringIn(10)

    await remindersJob.handle()
    await remindersJob.handle()

    const mails = await queuedMailsTo(user.email)
    assert.lengthOf(mails, 1)
    assert.equal(mails[0].subject, `Your ${product.name} license expires in 10 days`)
    assert.include(mails[0].text, license.keySuffix)
    assert.include(mails[0].text, `/pricing/${product.slug}`)

    const events = await LicenseEvent.query()
      .where('license_id', license.id)
      .where('type', 'expiry_reminder_sent')
    assert.lengthOf(events, 1)
    assert.equal(events[0].metadata?.days, 14)
  })

  test('sends the 3-day reminder as well, and nothing more', async ({ assert }) => {
    const { user, license } = await expiringIn(10)
    await remindersJob.handle()

    const nearer = DateTime.utc().plus({ days: 2 })
    license.expiresAt = nearer
    await licenses.record(license, 'expiry_reminder_sent', SYSTEM_ACTOR, {
      days: 14,
      expires_at: nearer.toUTC().toISO(),
    })
    await license.save()

    await remindersJob.handle()
    await remindersJob.handle()

    const mails = await queuedMailsTo(user.email)
    assert.lengthOf(mails, 2)
    assert.equal(mails[1].subject.endsWith('expires in 2 days'), true)
  })

  test('leaves alone what renews by itself, is far off, expired, or revoked', async ({
    assert,
  }) => {
    await expiringIn(10, { status: 'active', cancelAtPeriodEnd: false })
    await expiringIn(40)
    await expiringIn(-1)
    const revoked = await expiringIn(5)
    await licenses.revoke(revoked.license, 'refund', SYSTEM_ACTOR)

    await remindersJob.handle()

    assert.lengthOf(await queuedMails(), 0)
  })

  test('reminds a subscription that is cancelling, and sends it to billing', async ({ assert }) => {
    const { user } = await expiringIn(3, { status: 'active', cancelAtPeriodEnd: true })

    await remindersJob.handle()

    const [mail] = await queuedMailsTo(user.email)
    assert.exists(mail)
    assert.include(mail.text, '/billing')
  })
})
