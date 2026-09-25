import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import testUtils from '@adonisjs/core/services/test_utils'

import Notification from '#models/notification'
import notifications from '#notifications/notification_service'
import pruneNotificationsJob, {
  NOTIFICATION_RETENTION_DAYS,
} from '#queue/jobs/prune_notifications_job'
import {
  addMember,
  createCatalogPlan,
  createNotification,
  createWorkspace,
  runQueue,
} from '#tests/helpers'

/**
 * Unread state (plan §20.4) — one timestamp column, no receipts table.
 */
test.group('Notifications — what counts as unread', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('a published announcement is unread until the page is opened', async ({
    assert,
    client,
  }) => {
    const { user, organization } = await createWorkspace()
    await createNotification({ title: 'Maintenance on Sunday' })

    assert.equal(await notifications.unreadCountFor(user, organization), 1)

    const response = await client.get('/notifications').loginAs(user)

    response.assertStatus(200)
    response.assertTextIncludes('Maintenance on Sunday')

    await user.refresh()
    assert.equal(await notifications.unreadCountFor(user, organization), 0)
  })

  test('a second announcement brings the dot back', async ({ assert, client }) => {
    const { user, organization } = await createWorkspace()

    /**
     * Backdated, because in reality nobody publishes and reads in the same
     * second — and timestamps are stored to the second, so a test that did
     * would be asserting against the blind spot documented on
     * `unreadCountFor` rather than against the rule.
     */
    await createNotification({ title: 'First', publishedAt: DateTime.utc().minus({ hours: 1 }) })
    await client.get('/notifications').loginAs(user)
    await user.refresh()

    await createNotification({ title: 'Second', publishedAt: DateTime.utc().plus({ seconds: 2 }) })

    assert.equal(await notifications.unreadCountFor(user, organization), 1)
  })

  /**
   * The four states that must never light the dot.
   */
  test('a draft never counts', async ({ assert }) => {
    const { user, organization } = await createWorkspace()
    await createNotification({ publishNow: false })

    assert.equal(await notifications.unreadCountFor(user, organization), 0)
    assert.isEmpty(await notifications.feedFor(user, organization))
  })

  test('an expired one never counts', async ({ assert }) => {
    const { user, organization } = await createWorkspace()
    await createNotification({ expiresAt: DateTime.utc().minus({ days: 1 }) })

    assert.equal(await notifications.unreadCountFor(user, organization), 0)
    assert.isEmpty(await notifications.feedFor(user, organization))
  })

  test('one published before the last visit never counts', async ({ assert, client }) => {
    const { user, organization } = await createWorkspace()

    await client.get('/notifications').loginAs(user)
    await user.refresh()

    await createNotification({ publishedAt: DateTime.utc().minus({ days: 2 }) })

    assert.equal(await notifications.unreadCountFor(user, organization), 0, 'older than the visit')
    assert.lengthOf(await notifications.feedFor(user, organization), 1, 'but still on the page')
  })

  test('a deleted one never counts', async ({ assert }) => {
    const { user, organization } = await createWorkspace()
    const notification = await createNotification()

    await notifications.delete(notification)

    assert.equal(await notifications.unreadCountFor(user, organization), 0)
    assert.isEmpty(await notifications.feedFor(user, organization))
  })

  /**
   * Reading `seen_at` before stamping it is what makes "new since your last
   * visit" possible at all — stamping first would mark everything old on the
   * very page meant to show it as new.
   */
  test('the page highlights what arrived since the last visit', async ({ assert, client }) => {
    const { user, organization } = await createWorkspace()

    await createNotification({ title: 'Old news', publishedAt: DateTime.utc().minus({ hours: 1 }) })
    await client.get('/notifications').loginAs(user)
    await user.refresh()

    await createNotification({
      title: 'Fresh news',
      publishedAt: DateTime.utc().plus({ seconds: 2 }),
    })

    const feed = await notifications.feedFor(user, organization)
    const fresh = feed.find((entry) => entry.notification.title === 'Fresh news')
    const old = feed.find((entry) => entry.notification.title === 'Old news')

    assert.isTrue(fresh?.isNew)
    assert.isFalse(old?.isNew)

    const response = await client.get('/notifications').loginAs(user)
    response.assertTextIncludes('New')
  })

  test('someone who has never looked sees everything as new', async ({ assert }) => {
    const { user, organization } = await createWorkspace()
    await createNotification()

    assert.isNull(user.notificationsSeenAt ?? null)

    const feed = await notifications.feedFor(user, organization)
    assert.isTrue(feed[0].isNew)
  })

  test('visiting stamps the column exactly once per visit', async ({ assert, client }) => {
    const { user } = await createWorkspace()

    await client.get('/notifications').loginAs(user)
    await user.refresh()
    const first = user.notificationsSeenAt

    assert.isNotNull(first)

    await client.get('/notifications').loginAs(user)
    await user.refresh()

    assert.isAbove(user.notificationsSeenAt!.toMillis(), first!.toMillis() - 1)
  })
})

/**
 * The audience, through the real stack rather than the predicate alone
 * (plan §20.7).
 */
test.group('Notifications — who receives them', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  /**
   * An account, and optionally a live license for a product it then counts
   * as a customer of.
   */
  const customer = async (email: string, product?: { id: number; slug: string } | null) => {
    const { user, organization } = await createWorkspace({ email })

    if (product) {
      const { default: licenses, SYSTEM_ACTOR } = await import('#licensing/license_service')
      const { default: Plan } = await import('#models/plan')
      const plan = await Plan.query().where('product_id', product.id).firstOrFail()
      await licenses.issue({ organization, plan, source: 'manual', actor: SYSTEM_ACTOR })
    }

    return { user, organization }
  }

  const aProduct = async () => {
    const { product } = await createCatalogPlan()
    return product
  }

  test('everyone means everyone', async ({ assert }) => {
    const free = await customer('free@example.com')
    const pro = await customer('pro@example.com', await aProduct())

    await createNotification({ audienceType: 'all' })

    assert.lengthOf(await notifications.feedFor(free.user, free.organization), 1)
    assert.lengthOf(await notifications.feedFor(pro.user, pro.organization), 1)
  })

  test('a product audience reaches its customers only', async ({ assert }) => {
    const invoicePro = await aProduct()
    const bookingPro = await aProduct()

    const nobody = await customer('nobody@example.com')
    const other = await customer('other@example.com', bookingPro)
    const buyer = await customer('buyer@example.com', invoicePro)

    await createNotification({ audienceType: 'product', productIds: [invoicePro.id] })

    assert.isEmpty(await notifications.feedFor(nobody.user, nobody.organization))
    assert.isEmpty(await notifications.feedFor(other.user, other.organization))
    assert.lengthOf(await notifications.feedFor(buyer.user, buyer.organization), 1)
  })

  /**
   * A revoked or expired license is no longer "a customer of" the product.
   */
  test('a license that is no longer live stops the announcement reaching them', async ({
    assert,
  }) => {
    const invoicePro = await aProduct()
    const buyer = await customer('buyer@example.com', invoicePro)
    const { default: License } = await import('#models/license')
    const { default: licenses, SYSTEM_ACTOR } = await import('#licensing/license_service')

    await createNotification({ audienceType: 'product', productIds: [invoicePro.id] })
    assert.lengthOf(await notifications.feedFor(buyer.user, buyer.organization), 1)

    const license = await License.findByOrFail('organization_id', buyer.organization.id)
    await licenses.revoke(license, 'refund', SYSTEM_ACTOR)

    assert.isEmpty(await notifications.feedFor(buyer.user, buyer.organization))
  })

  test('an owners audience reaches no members', async ({ assert }) => {
    const { user, organization } = await createWorkspace()
    const member = await addMember(organization, user, 'sam@example.com')

    await createNotification({ audienceType: 'owners' })

    assert.lengthOf(await notifications.feedFor(user, organization), 1, 'the owner')
    assert.isEmpty(await notifications.feedFor(member, organization), 'not the member')
  })

  test('a named audience reaches exactly those people', async ({ assert }) => {
    const { user, organization } = await createWorkspace()
    const member = await addMember(organization, user, 'sam@example.com')

    await createNotification({ audienceType: 'users', userIds: [member.id] })

    assert.isEmpty(await notifications.feedFor(user, organization), 'not the owner')
    assert.lengthOf(await notifications.feedFor(member, organization), 1, 'the named member')
  })

  /**
   * The count the back-office shows before publishing comes from the same
   * predicate the feed uses, so what it promises is what happens.
   */
  test('the reach figure matches who actually sees it', async ({ assert }) => {
    const invoicePro = await aProduct()
    const free = await customer('free@example.com')
    const pro = await customer('pro@example.com', invoicePro)
    await addMember(pro.organization, pro.user, 'sam@example.com')

    const notification = await createNotification({
      audienceType: 'product',
      productIds: [invoicePro.id],
    })

    assert.equal(await notifications.reachOf(notification), 2, 'the customer and their member')

    const seen = await Promise.all(
      [free, pro].map(async (workspace) => {
        const feed = await notifications.feedFor(workspace.user, workspace.organization)
        return feed.length
      })
    )

    assert.deepEqual(seen, [0, 1])
  })
})

/**
 * Authoring (plan §20.5, §20.6).
 */
test.group('Notifications — the back-office', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  const aProductForAuthoring = async () => {
    const { product } = await createCatalogPlan()
    return product
  }

  const customerOf = async (product: { id: number }) => {
    const { organization } = await createWorkspace()
    const { default: licenses, SYSTEM_ACTOR } = await import('#licensing/license_service')
    const { default: Plan } = await import('#models/plan')
    const plan = await Plan.query().where('product_id', product.id).firstOrFail()
    await licenses.issue({ organization, plan, source: 'manual', actor: SYSTEM_ACTOR })
  }

  const form = (overrides: Record<string, unknown> = {}) => ({
    title: 'Invoice Pro 2.5 is out',
    body: 'Recurring invoices can now be paused.',
    audienceType: 'all',
    ...overrides,
  })

  test('an admin can publish one, and it is audited with its reach', async ({ client, assert }) => {
    const { createStaff } = await import('#tests/helpers')
    const staff = await createStaff({ role: 'admin' })

    const invoicePro = await aProductForAuthoring()
    await customerOf(invoicePro)

    const response = await client
      .post('/admin/notifications')
      .withGuard('staff')
      .loginAs(staff)
      .form(form({ audienceType: 'product', productIds: [String(invoicePro.id)] }))
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)

    const notification = await Notification.query().firstOrFail()
    assert.equal(notification.audienceType, 'product')
    assert.deepEqual(notification.audience, { productIds: [invoicePro.id] })
    assert.isFalse(notification.isDraft)
    assert.equal(notification.createdByStaffId, staff.id)

    const { default: AuditLog } = await import('#models/audit_log')
    const entry = await AuditLog.query().where('action', 'notification.created').firstOrFail()
    assert.equal(entry.metadata?.reach, 1)
  })

  test('support can read the list but not write one', async ({ client, assert }) => {
    const { createStaff } = await import('#tests/helpers')
    const staff = await createStaff({ role: 'support' })

    const list = await client.get('/admin/notifications').withGuard('staff').loginAs(staff)

    list.assertStatus(200)
    assert.notInclude(list.text(), 'New announcement', 'the form is not rendered')

    const write = await client
      .post('/admin/notifications')
      .withGuard('staff')
      .loginAs(staff)
      .form(form())
      .withCsrfToken()
      .redirects(0)

    write.assertStatus(302)
    assert.isEmpty(await Notification.all())
  })

  test('a draft reaches nobody until it is published', async ({ client, assert }) => {
    const { createStaff } = await import('#tests/helpers')
    const staff = await createStaff({ role: 'admin' })
    const { user, organization } = await createWorkspace()

    await client
      .post('/admin/notifications')
      .withGuard('staff')
      .loginAs(staff)
      .form(form({ audienceType: 'all', saveAsDraft: '1' }))
      .withCsrfToken()
      .redirects(0)

    const notification = await Notification.query().firstOrFail()
    assert.isTrue(notification.isDraft)
    assert.isEmpty(await notifications.feedFor(user, organization))

    await client
      .post(`/admin/notifications/${notification.publicId}/publish`)
      .withGuard('staff')
      .loginAs(staff)
      .withCsrfToken()
      .redirects(0)

    await notification.refresh()
    assert.isFalse(notification.isDraft)
    assert.lengthOf(await notifications.feedFor(user, organization), 1)
  })

  /**
   * A label with no URL is a button that does nothing.
   */
  test('half a call to action is refused', async ({ client, assert }) => {
    const { createStaff } = await import('#tests/helpers')
    const staff = await createStaff({ role: 'admin' })

    await client
      .post('/admin/notifications')
      .withGuard('staff')
      .loginAs(staff)
      .form(form({ actionLabel: 'See plans' }))
      .withCsrfToken()
      .redirects(0)

    assert.isEmpty(await Notification.all())
  })

  /**
   * The fields a chosen audience does not use are dropped, so a row never
   * carries a stale list that the UI cannot show and the predicate ignores —
   * until somebody widens the rule.
   */
  test('an audience keeps only the fields its type uses', async ({ client, assert }) => {
    const { createStaff } = await import('#tests/helpers')
    const staff = await createStaff({ role: 'admin' })

    await client
      .post('/admin/notifications')
      .withGuard('staff')
      .loginAs(staff)
      .form(form({ audienceType: 'users', productIds: ['3'], userIds: ['4'] }))
      .withCsrfToken()
      .redirects(0)

    const notification = await Notification.query().firstOrFail()

    assert.deepEqual(
      notification.audience,
      { userIds: [4] },
      'the plans went, and the id is a number'
    )
  })

  test('deleting takes it off every screen and is audited', async ({ client, assert }) => {
    const { createStaff } = await import('#tests/helpers')
    const staff = await createStaff({ role: 'admin' })
    const { user, organization } = await createWorkspace()

    const notification = await createNotification()
    assert.lengthOf(await notifications.feedFor(user, organization), 1)

    await client
      .post(`/admin/notifications/${notification.publicId}/delete`)
      .withGuard('staff')
      .loginAs(staff)
      .withCsrfToken()
      .redirects(0)

    assert.isEmpty(await notifications.feedFor(user, organization))

    const { default: AuditLog } = await import('#models/audit_log')
    assert.lengthOf(await AuditLog.query().where('action', 'notification.deleted'), 1)
  })
})

test.group('Notifications — pruning', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('keeps a deleted announcement inside the recovery window', async ({ assert }) => {
    const notification = await createNotification()
    await notifications.delete(notification)

    notification.deletedAt = DateTime.utc().minus({ days: NOTIFICATION_RETENTION_DAYS - 1 })
    await notification.save()

    await pruneNotificationsJob.handle()

    assert.isNotNull(await Notification.find(notification.id))
  })

  test('removes it once the window has passed', async ({ assert }) => {
    const notification = await createNotification()
    await notifications.delete(notification)

    notification.deletedAt = DateTime.utc().minus({ days: NOTIFICATION_RETENTION_DAYS + 1 })
    await notification.save()

    await pruneNotificationsJob.handle()

    assert.isNull(await Notification.find(notification.id))
  })

  test('never touches one that was not deleted', async ({ assert }) => {
    const notification = await createNotification()

    await pruneNotificationsJob.handle()

    assert.isNotNull(await Notification.find(notification.id))
  })

  test('runs through the queue like every other job', async ({ assert }) => {
    const { default: queue } = await import('#queue/queue_service')
    await queue.dispatch(pruneNotificationsJob)

    assert.equal(await runQueue('default'), 1)
  })
})
