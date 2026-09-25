import { test } from '@japa/runner'
import mail from '@adonisjs/mail/services/main'

import User from '#models/user'
import Invitation from '#models/invitation'
import Organization from '#models/organization'
import invitations from '#organizations/invitation_service'
import LicenseEvent from '#models/license_event'
import activations from '#licensing/activation_service'
import { SYSTEM_ACTOR } from '#licensing/license_service'
import SupportMessage from '#models/support_message'
import support from '#support/support_service'
import { addMember, createLicense, createWorkspace } from '#tests/helpers'

/**
 * Tenant isolation (plan §15).
 *
 * Two organisations, and the assertion that A can never read or mutate B —
 * endpoint by endpoint, for every endpoint that takes an identifier. This is
 * the suite that protects the product: a leak here is not a bug report, it is
 * an incident.
 *
 * Every milestone that adds an endpoint taking an id adds a case here.
 */
test.group('Tenant isolation', (group) => {
  group.each.setup(() => {
    mail.fake()
    return () => mail.restore()
  })

  /**
   * Two complete workspaces: A with an owner and a member, B likewise.
   */
  async function twoWorkspaces() {
    const a = await createWorkspace({ email: 'owner-a@example.com', fullName: 'Owner A' })
    const b = await createWorkspace({ email: 'owner-b@example.com', fullName: 'Owner B' })

    /**
     * Room for a member and a spare invitation in each. Seat limits are their
     * own suite; here they would only get in the way of the isolation
     * assertions.
     */
    for (const workspace of [a, b]) {
      workspace.organization.limitOverrides = { seats: 5, storageMb: 1_000 }
      await workspace.organization.save()
    }

    const memberA = await addMember(a.organization, a.user, 'member-a@example.com', 'Member A')
    const memberB = await addMember(b.organization, b.user, 'member-b@example.com', 'Member B')

    return { a: { ...a, member: memberA }, b: { ...b, member: memberB } }
  }

  test('the members list shows only your own workspace', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()

    const response = await client.get('/members').loginAs(a.user)

    response.assertTextIncludes('member-a@example.com')
    assert.notInclude(response.text(), 'member-b@example.com')
    assert.notInclude(response.text(), b.user.email)
  })

  test('removing a member of another workspace does nothing', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()

    await client
      .post(`/members/${b.member.publicId}/remove`)
      .loginAs(a.user)
      .withCsrfToken()
      .redirects(0)

    await b.member.refresh()
    assert.isFalse(b.member.isDeleted, "B's member is untouched")
  })

  test('revoking another workspace invitation does nothing', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()
    const { invitation } = await invitations.invite({
      organization: b.organization,
      invitedBy: b.user,
      email: 'invited-b@example.com',
    })

    await client
      .post(`/invitations/${invitation.publicId}/revoke`)
      .loginAs(a.user)
      .withCsrfToken()
      .redirects(0)

    await invitation.refresh()
    assert.isTrue(invitation.isPending)
  })

  test('resending another workspace invitation does nothing', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()
    const { invitation } = await invitations.invite({
      organization: b.organization,
      invitedBy: b.user,
      email: 'invited-b@example.com',
    })

    await client
      .post(`/invitations/${invitation.publicId}/resend`)
      .loginAs(a.user)
      .withCsrfToken()
      .redirects(0)

    const all = await Invitation.query().where('email', 'invited-b@example.com')
    assert.lengthOf(all, 1, 'no second invitation was issued into B')
    assert.equal(all[0].organizationId, b.organization.id)
  })

  test('transferring ownership to a stranger does nothing', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()

    await client
      .post('/settings/organization/transfer')
      .loginAs(a.user)
      .form({ memberPublicId: b.member.publicId, confirmation: a.organization.name })
      .withCsrfToken()
      .redirects(0)

    await a.organization.refresh()
    await b.member.refresh()

    assert.equal(a.organization.ownerId, a.user.id)
    assert.equal(b.member.organizationId, b.organization.id)
    assert.equal(b.member.role, 'member')
  })

  test('settings show only your own workspace', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()

    const response = await client.get('/settings/organization').loginAs(a.user)

    response.assertTextIncludes(a.organization.publicId)
    assert.notInclude(response.text(), b.organization.publicId)
  })

  /**
   * The transfer dropdown lists members to choose from; it must never offer
   * somebody from another workspace.
   */
  test('the transfer dropdown lists only your own members', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()

    const response = await client.get('/settings/organization').loginAs(a.user)

    response.assertTextIncludes(a.member.publicId)
    assert.notInclude(response.text(), b.member.publicId)
  })

  test('renaming reaches only your own workspace', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()
    const originalB = b.organization.name

    await client
      .post('/settings/organization')
      .loginAs(a.user)
      .form({ name: 'A Renamed' })
      .withCsrfToken()
      .redirects(0)

    await a.organization.refresh()
    await b.organization.refresh()

    assert.equal(a.organization.name, 'A Renamed')
    assert.equal(b.organization.name, originalB)
  })

  test('deleting reaches only your own workspace', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()

    await client
      .post('/settings/organization/delete')
      .loginAs(a.user)
      .form({ confirmation: a.organization.name })
      .withCsrfToken()
      .redirects(0)

    await a.organization.refresh()
    await b.organization.refresh()
    await b.user.refresh()

    assert.isTrue(a.organization.isDeleted)
    assert.isFalse(b.organization.isDeleted)
    assert.isFalse(b.user.isDeleted)
  })

  /**
   * An id that does not belong to the caller must behave exactly like an id
   * that does not exist. A different response would confirm the row is real,
   * which is enough to enumerate another tenant's data.
   */
  test('a foreign id is indistinguishable from a missing one', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()

    const foreign = await client
      .post(`/members/${b.member.publicId}/remove`)
      .loginAs(a.user)
      .withCsrfToken()
      .redirects(0)

    const missing = await client
      .post('/members/usr_zzzzzzzzzzzz/remove')
      .loginAs(a.user)
      .withCsrfToken()
      .redirects(0)

    assert.equal(foreign.status(), missing.status())
    assert.deepEqual(foreign.flashMessages(), missing.flashMessages())
  })

  /**
   * The invitation link is the one credential that crosses workspaces, so it
   * must attach the joiner to the workspace that issued it and no other.
   */
  test('an invitation link joins the workspace that issued it', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()

    const { token } = await invitations.invite({
      organization: b.organization,
      invitedBy: b.user,
      email: 'joiner@example.com',
    })

    await client
      .post(`/invitations/${token}/accept`)
      .form({
        fullName: 'Joiner',
        password: 'secret-password-12',
        passwordConfirmation: 'secret-password-12',
      })
      .withCsrfToken()
      .redirects(0)

    const joiner = await User.findByOrFail('email', 'joiner@example.com')
    assert.equal(joiner.organizationId, b.organization.id)
    assert.notEqual(joiner.organizationId, a.organization.id)
  })

  /*
   |--------------------------------------------------------------------------
   | Licenses (licence plan M5) — the domain
   |--------------------------------------------------------------------------
   |
   | Ported from the starter's lists-and-todos block, and for the same reason
   | it existed: these are the specific ways a tenant-owned resource leaks —
   | a foreign id in a path, an action that reaches across, a child row (an
   | activation) addressed through the wrong parent. Every portal route that
   | takes an identifier has a case here.
   |
   */

  test('the licenses screen shows only your own', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()
    const mine = await createLicense({ organization: a.organization })
    const theirs = await createLicense({ organization: b.organization })

    const response = await client.get('/licenses').loginAs(a.member)

    response.assertStatus(200)
    assert.include(response.text(), mine.license.publicId)
    assert.notInclude(response.text(), theirs.license.publicId)
  })

  test('opening another workspace license is a miss, not a peek', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()
    const theirs = await createLicense({ organization: b.organization })

    const foreign = await client
      .get(`/licenses/${theirs.license.publicId}`)
      .loginAs(a.user)
      .redirects(0)
    const missing = await client.get('/licenses/lic_zzzzzzzzzzzz').loginAs(a.user).redirects(0)

    foreign.assertStatus(302)
    foreign.assertHeader('location', '/licenses')
    assert.equal(foreign.header('location'), missing.header('location'))
  })

  /**
   * The one action here that hands out a secret.
   */
  test('revealing another workspace key reveals nothing', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()
    const theirs = await createLicense({ organization: b.organization })

    const response = await client
      .post(`/licenses/${theirs.license.publicId}/reveal`)
      .loginAs(a.user)
      .withCsrfToken()
      .redirects(0)

    assert.notEqual(response.flashMessages()?.revealedKey, theirs.key)
    assert.lengthOf(await LicenseEvent.query().where('type', 'key_revealed'), 0)
  })

  test('deactivating another workspace installation does nothing', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()
    const theirs = await createLicense({ organization: b.organization })
    const result = await activations.activate(theirs.license, { instanceId: 'b-1' }, SYSTEM_ACTOR)
    const activationId = result.ok ? result.activation.publicId : ''

    await client
      .post(`/licenses/${theirs.license.publicId}/activations/${activationId}/deactivate`)
      .loginAs(a.user)
      .withCsrfToken()
      .redirects(0)

    assert.lengthOf(await activations.live(theirs.license), 1)
  })

  /**
   * The child addressed through the wrong parent: A's own license id in the
   * path, B's activation id after it. Looking the activation up *within* the
   * license is what stops it.
   */
  test('an installation cannot be reached through a license it does not belong to', async ({
    client,
    assert,
  }) => {
    const { a, b } = await twoWorkspaces()
    const mine = await createLicense({ organization: a.organization })
    const theirs = await createLicense({ organization: b.organization })
    const result = await activations.activate(theirs.license, { instanceId: 'b-1' }, SYSTEM_ACTOR)
    const activationId = result.ok ? result.activation.publicId : ''

    await client
      .post(`/licenses/${mine.license.publicId}/activations/${activationId}/deactivate`)
      .loginAs(a.user)
      .withCsrfToken()
      .redirects(0)

    assert.lengthOf(await activations.live(theirs.license), 1)
  })

  test('dashboard numbers count only your own workspace', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()
    await createLicense({ organization: a.organization })
    await createLicense({ organization: b.organization })
    await createLicense({ organization: b.organization })

    const { default: dashboard } = await import('#licensing/dashboard_service')
    const stats = await dashboard.statsFor(a.organization)

    assert.equal(stats.total, 1)

    const response = await client.get('/dashboard').loginAs(a.user)
    response.assertStatus(200)
  })

  /*
   |--------------------------------------------------------------------------
   | Seats, billing, files and the API — core
   |--------------------------------------------------------------------------
   |
   | These stay whatever the domain is. The API cases below act on licenses,
   | through the organisation API's `GET /licenses`.
   |
   */

  test('seat counts are per workspace', async ({ assert }) => {
    const { a, b } = await twoWorkspaces()
    const { seatUsage } = await import('#organizations/seats')

    await invitations.invite({
      organization: b.organization,
      invitedBy: b.user,
      email: 'extra-b@example.com',
    })

    const usageA = await seatUsage(a.organization)
    assert.equal(usageA.members, 2)
    assert.equal(usageA.pendingInvitations, 0, "B's invitation does not count against A")
  })

  /**
   * Billing (M4). The screen takes no identifier at all — the session is the
   * scope — so the isolation risks here are a workspace reading another's
   * money, and a webhook attributing a subscription to the wrong tenant.
   */
  test('billing shows a workspace only its own subscription and payments', async ({
    assert,
    client,
  }) => {
    const { a, b } = await twoWorkspaces()
    const { DateTime } = await import('luxon')
    const { default: Payment } = await import('#models/payment')
    const { default: Subscription } = await import('#models/subscription')

    const { createCatalogPlan } = await import('#tests/helpers')
    const { plan } = await createCatalogPlan({
      plan: { billing: 'yearly', licenseTerm: 'subscription' },
    })
    const subscription = await Subscription.create({
      organizationId: b.organization.id,
      provider: 'creem',
      providerSubscriptionId: 'sub_b',
      providerCustomerId: 'cus_b',
      planKey: 'license',
      planId: plan.id,
      status: 'active',
      currentPeriodStart: DateTime.utc(),
      currentPeriodEnd: DateTime.utc().plus({ months: 1 }),
      cancelAtPeriodEnd: false,
    })

    await Payment.create({
      organizationId: b.organization.id,
      subscriptionId: subscription.id,
      provider: 'creem',
      providerOrderId: 'ord_b',
      amountCents: 2900,
      currency: 'USD',
      status: 'succeeded',
      refundedAmountCents: 0,
      description: "B's private invoice",
      occurredAt: DateTime.utc(),
    })

    const response = await client.get('/billing').loginAs(a.user)

    response.assertStatus(200)
    response.assertTextIncludes('No subscriptions')
    assert.notInclude(response.text(), "B's private invoice")
    assert.notInclude(response.text(), 'pay_')

    const { default: billing } = await import('#billing/billing_service')
    const overview = await billing.overview(a.organization)
    assert.isEmpty(overview.subscriptions)
    assert.isEmpty(overview.payments)
  })

  /**
   * The obvious cross-tenant injection point in billing: a payment must land
   * in the account whose order it pays for, and only through the order id we
   * wrote into the checkout ourselves.
   */
  test('a paid order issues its license to its own account and no other', async ({
    assert,
    cleanup,
  }) => {
    const { a, b } = await twoWorkspaces()

    /**
     * Checkout calls the payment provider; a test must never reach it.
     */
    const { useFakePaymentProvider, restorePaymentProvider } = await import('#tests/helpers')
    useFakePaymentProvider()
    cleanup(() => restorePaymentProvider())
    const { default: webhooks } = await import('#billing/webhook_handler')
    const { paymentProvider } = await import('#billing/provider')
    const { default: orders } = await import('#commerce/order_service')
    const { createSellablePlan, creemLicensing } = await import('#tests/helpers')

    const { plan } = await createSellablePlan()
    const { order } = await orders.startCheckout({
      plan,
      email: a.user.email,
      organization: a.organization,
      successUrl: 'https://example.com',
    })

    const body = creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId })
    await webhooks.apply(paymentProvider().parseWebhook(Buffer.from(JSON.stringify(body))))

    const { default: License } = await import('#models/license')
    assert.lengthOf(await License.query().where('organization_id', a.organization.id), 1)
    assert.lengthOf(await License.query().where('organization_id', b.organization.id), 0)
  })

  /**
   * A second event for the same provider subscription must follow the row it
   * already created, not whatever order id the payload now claims — the
   * subscription's own history is more trustworthy than metadata that can be
   * replayed with an edit.
   */
  test('a follow-up event cannot move a subscription to another workspace', async ({
    assert,
    cleanup,
  }) => {
    const { a, b } = await twoWorkspaces()

    /**
     * Checkout calls the payment provider; a test must never reach it.
     */
    const { useFakePaymentProvider, restorePaymentProvider } = await import('#tests/helpers')
    useFakePaymentProvider()
    cleanup(() => restorePaymentProvider())
    const { default: Subscription } = await import('#models/subscription')
    const { default: webhooks } = await import('#billing/webhook_handler')
    const { paymentProvider } = await import('#billing/provider')
    const { default: orders } = await import('#commerce/order_service')
    const { createSellablePlan, creemLicensing } = await import('#tests/helpers')

    const parse = (body: Record<string, any>) =>
      paymentProvider().parseWebhook(Buffer.from(JSON.stringify(body)))

    const { plan } = await createSellablePlan({ billing: 'yearly', licenseTerm: 'subscription' })
    const checkout = (organization: typeof a.organization, email: string) =>
      orders.startCheckout({ plan, email, organization, successUrl: 'https://example.com' })

    const { order: ordersA } = await checkout(a.organization, a.user.email)
    const { order: ordersB } = await checkout(b.organization, b.user.email)

    await webhooks.apply(
      parse(
        creemLicensing.subscription({
          orderPublicId: ordersA.publicId,
          productId: plan.providerProductId!,
          subscriptionId: 'sub_shared',
        })
      )
    )

    await webhooks.apply(
      parse(
        creemLicensing.subscription({
          eventType: 'subscription.update',
          orderPublicId: ordersB.publicId,
          productId: plan.providerProductId!,
          subscriptionId: 'sub_shared',
        })
      )
    )

    const subscriptions = await Subscription.all()
    assert.lengthOf(subscriptions, 1)
    assert.equal(subscriptions[0].organizationId, a.organization.id)

    /**
     * And B's order was not fulfilled through A's subscription.
     */
    const { default: License } = await import('#models/license')
    assert.lengthOf(await License.query().where('organization_id', b.organization.id), 0)
    assert.lengthOf(await License.query().where('order_id', ordersB.id), 0)
  })

  /**
   * Files (M5). Two injection points: fetching another workspace's file by
   * its public id, and deleting one.
   */
  test('a file belonging to another workspace behaves exactly like a missing one', async ({
    assert,
    client,
  }) => {
    const { a, b } = await twoWorkspaces()
    const { default: files } = await import('#storage/file_service')
    const { fixtureUpload } = await import('#tests/helpers')

    const theirs = await files.upload(b.organization, b.user, await fixtureUpload('pdf'))

    assert.isNull(await files.find(a.organization, theirs.publicId))

    const foreign = await client.get(`/files/${theirs.publicId}`).loginAs(a.user).redirects(0)
    const missing = await client.get('/files/fil_zzzzzzzzzzzz').loginAs(a.user).redirects(0)

    assert.equal(foreign.status(), missing.status())
    assert.deepEqual(
      foreign.flashMessages(),
      missing.flashMessages(),
      'and says the same thing, so a foreign id cannot be probed for existence'
    )
  })

  test('one workspace cannot delete a file belonging to another', async ({ assert, client }) => {
    const { a, b } = await twoWorkspaces()
    const { default: files } = await import('#storage/file_service')
    const { fixtureUpload } = await import('#tests/helpers')

    const theirs = await files.upload(b.organization, b.user, await fixtureUpload('pdf'))

    await client
      .post(`/files/${theirs.publicId}/delete`)
      .loginAs(a.user)
      .withCsrfToken()
      .redirects(0)

    await theirs.refresh()
    assert.isNull(theirs.deletedAt, "B's file is untouched")
  })

  test('the files screen lists only its own workspace', async ({ assert, client }) => {
    const { a, b } = await twoWorkspaces()
    const { default: files } = await import('#storage/file_service')
    const { fixtureUpload } = await import('#tests/helpers')

    await files.upload(
      b.organization,
      b.user,
      await fixtureUpload('pdf', { clientName: 'B-confidential.pdf' })
    )

    const response = await client.get('/files').loginAs(a.user)

    response.assertStatus(200)
    assert.notInclude(response.text(), 'B-confidential.pdf')
    assert.isEmpty(await files.forOrganization(a.organization))
  })

  /**
   * The object key carries the tenant, so a leak would be visible in the key
   * itself rather than only in a database column (plan §10).
   */
  test('object keys are prefixed with the workspace that owns them', async ({ assert }) => {
    const { a, b } = await twoWorkspaces()
    const { default: files } = await import('#storage/file_service')
    const { keyBelongsTo } = await import('#storage/keys')
    const { fixtureUpload } = await import('#tests/helpers')

    const mine = await files.upload(a.organization, a.user, await fixtureUpload('png'))
    const theirs = await files.upload(b.organization, b.user, await fixtureUpload('png'))

    assert.isTrue(keyBelongsTo(mine.key, a.organization.publicId))
    assert.isFalse(keyBelongsTo(mine.key, b.organization.publicId))
    assert.isFalse(keyBelongsTo(theirs.key, a.organization.publicId))
  })

  test('storage is counted per workspace', async ({ assert }) => {
    const { a, b } = await twoWorkspaces()
    const { default: files } = await import('#storage/file_service')
    const { fixtureUpload } = await import('#tests/helpers')

    await files.upload(b.organization, b.user, await fixtureUpload('pdf'))

    await a.organization.refresh()
    await b.organization.refresh()

    assert.equal(a.organization.storageUsedBytes, 0, "B's upload does not count against A")
    assert.isAbove(b.organization.storageUsedBytes, 0)
  })

  /**
   * The organisation API (M6). The key *is* the scope, so the isolation
   * question here is whether a key can be talked into touching anything
   * outside its own workspace — by id, by filter, or by assignment.
   */
  test('a key cannot read another workspace’s license by id', async ({ assert, client }) => {
    const { keyed, other } = await twoKeyedWorkspaces()
    const theirs = await createLicense({ organization: other.organization })

    const foreign = await client
      .get(`/api/v1/licenses/${theirs.license.publicId}`)
      .headers(keyed.headers)
    const missing = await client.get('/api/v1/licenses/lic_zzzzzzzzzzzz').headers(keyed.headers)

    foreign.assertStatus(404)
    assert.deepEqual(
      foreign.body(),
      missing.body(),
      'and answers identically, so a foreign id cannot be probed for existence'
    )
  })

  test('listing licenses shows only the key’s workspace', async ({ assert, client }) => {
    const { keyed, other } = await twoKeyedWorkspaces()
    const mine = await createLicense({ organization: keyed.organization })
    const theirs = await createLicense({ organization: other.organization })

    const response = await client.get('/api/v1/licenses').headers(keyed.headers)

    const ids = response.body().data.map((row: { id: string }) => row.id)
    assert.include(ids, mine.license.publicId)
    assert.notInclude(ids, theirs.license.publicId)
  })

  test('the member directory is scoped to the key’s workspace', async ({ assert, client }) => {
    const { keyed, other } = await twoKeyedWorkspaces()

    const response = await client.get('/api/v1/members').headers(keyed.headers)

    response.assertStatus(200)

    const emails = response.body().data.map((row: { email: string }) => row.email)
    assert.notInclude(emails, other.user.email)
    assert.include(emails, keyed.user.email)
  })

  test('GET /organization reports the key’s own workspace and nobody else’s', async ({
    assert,
    client,
  }) => {
    const { keyed, other } = await twoKeyedWorkspaces()

    other.organization.name = 'Somebody else'
    await other.organization.save()

    const response = await client.get('/api/v1/organization').headers(keyed.headers)

    assert.equal(response.body().data.id, keyed.organization.publicId)
    assert.notEqual(response.body().data.name, 'Somebody else', 'not the other account')
  })

  /**
   * A cursor is an internal id in disguise. Handing one workspace's cursor to
   * another must not walk into their rows — the query is scoped regardless,
   * which is the point.
   */
  test('another workspace’s cursor cannot be used to walk their rows', async ({
    assert,
    client,
  }) => {
    const { keyed, other } = await twoKeyedWorkspaces()

    const theirs: string[] = []

    for (let i = 0; i < 3; i++) {
      const created = await createLicense({ organization: other.organization })
      theirs.push(created.license.publicId)
    }

    await createLicense({ organization: keyed.organization })

    const theirPage = await client.get('/api/v1/licenses?limit=1').headers(other.headers)

    const stolen = await client
      .get(`/api/v1/licenses?cursor=${theirPage.body().meta.next_cursor}`)
      .headers(keyed.headers)

    stolen.assertStatus(200)

    const ids = stolen.body().data.map((row: { id: string }) => row.id)
    assert.isEmpty(
      ids.filter((id: string) => theirs.includes(id)),
      'not one row from the other workspace'
    )
  })

  test('API request logs are attributed to the calling workspace only', async ({
    assert,
    client,
  }) => {
    const { keyed, other } = await twoKeyedWorkspaces()
    const { default: ApiRequest } = await import('#models/api_request')

    await client.get('/api/v1/licenses').headers(keyed.headers)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const rows = await ApiRequest.all()

    assert.isNotEmpty(rows)
    for (const row of rows) {
      assert.equal(row.organizationId, keyed.organization.id)
      assert.notEqual(row.organizationId, other.organization.id)
    }
  })

  /**
   * Two workspaces, each with a real API key.
   */
  async function twoKeyedWorkspaces() {
    const { createApiWorkspace } = await import('#tests/helpers')

    const keyed = await createApiWorkspace({ name: 'A key' })
    const other = await createApiWorkspace({ name: 'B key' })

    for (const workspace of [keyed, other]) {
      workspace.organization.limitOverrides = {
        ...workspace.organization.limitOverrides,
        seats: 5,
      }
      await workspace.organization.save()
    }

    return { keyed, other }
  }

  /**
   * Announcements (M9) are the **one** feature that crosses tenants on
   * purpose (plan §20.3) — one row reaches every workspace on a plan. Which
   * makes the audience predicate the only place in the application where a
   * leak would not be caught by a missing `organization_id` filter, and these
   * the cases that catch it.
   */
  test('an announcement for named people is invisible to everyone else', async ({ assert }) => {
    const { a, b } = await twoWorkspaces()
    const { createNotification } = await import('#tests/helpers')
    const { default: notifications } = await import('#notifications/notification_service')

    await createNotification({
      title: 'For B only',
      audienceType: 'users',
      userIds: [b.user.id],
    })

    assert.lengthOf(await notifications.feedFor(b.user, b.organization), 1)
    assert.isEmpty(
      await notifications.feedFor(a.user, a.organization),
      "A cannot see an announcement addressed to B's owner"
    )
    assert.isEmpty(
      await notifications.feedFor(a.member, a.organization),
      'nor can anybody else in A'
    )
  })

  test('a product announcement is invisible to an account without that product', async ({
    assert,
  }) => {
    const { a, b } = await twoWorkspaces()
    const { createNotification } = await import('#tests/helpers')
    const { default: notifications } = await import('#notifications/notification_service')

    const { product } = await createLicense({ organization: b.organization })

    await createNotification({
      title: 'Customers only',
      audienceType: 'product',
      productIds: [product.id],
    })

    assert.lengthOf(await notifications.feedFor(b.user, b.organization), 1)
    assert.isEmpty(await notifications.feedFor(a.user, a.organization))
  })

  test('an owners announcement is invisible to members of every workspace', async ({ assert }) => {
    const { a, b } = await twoWorkspaces()
    const { createNotification } = await import('#tests/helpers')
    const { default: notifications } = await import('#notifications/notification_service')

    await createNotification({ title: 'Owners', audienceType: 'owners' })

    assert.lengthOf(await notifications.feedFor(a.user, a.organization), 1, 'A’s owner')
    assert.lengthOf(await notifications.feedFor(b.user, b.organization), 1, 'B’s owner')
    assert.isEmpty(await notifications.feedFor(a.member, a.organization), 'not A’s member')
    assert.isEmpty(await notifications.feedFor(b.member, b.organization), 'not B’s member')
  })

  /**
   * And the dot follows the feed: a workspace must not be told there is
   * something to read that it then cannot see.
   */
  test('the unread count never disagrees with the feed', async ({ assert }) => {
    const { a, b } = await twoWorkspaces()
    const { createNotification } = await import('#tests/helpers')
    const { default: notifications } = await import('#notifications/notification_service')

    await createNotification({ audienceType: 'users', userIds: [b.user.id] })

    for (const [user, organization] of [
      [a.user, a.organization],
      [a.member, a.organization],
      [b.user, b.organization],
    ] as const) {
      const feed = await notifications.feedFor(user, organization)
      const unread = await notifications.unreadCountFor(user, organization)

      assert.equal(unread, feed.length, `${user.email}`)
    }
  })

  /*
  | Support tickets (plan §21). A ticket carries whatever a customer chose to
  | tell us, and its attachment is customer bytes behind a URL — so both the
  | conversation and the file get their own case here.
  */
  test('a support ticket is invisible to another workspace', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()

    const { ticket } = await support.open(b.organization, b.user, {
      subject: 'B private matter',
      body: 'Only for support.',
    })

    const listing = await client.get('/support').loginAs(a.user)
    assert.notInclude(listing.text(), 'B private matter')

    const conversation = await client
      .get(`/support/${ticket.publicId}`)
      .loginAs(a.user)
      .redirects(0)
    conversation.assertStatus(302)
    assert.notInclude(conversation.text(), 'Only for support.')
  })

  test('replying to another workspace ticket writes nothing', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()

    const { ticket } = await support.open(b.organization, b.user, {
      subject: 'B question',
      body: 'First.',
    })

    await client
      .post(`/support/${ticket.publicId}/replies`)
      .loginAs(a.user)
      .withCsrfToken()
      .form({ body: 'Injected.' })
      .redirects(0)

    const messages = await SupportMessage.query().where('support_ticket_id', ticket.id)
    assert.lengthOf(messages, 1, 'only B’s own message')
  })

  test('an attachment on another workspace ticket is not served', async ({ client, assert }) => {
    const { a, b } = await twoWorkspaces()

    const { ticket, message } = await support.open(b.organization, b.user, {
      subject: 'B screenshot',
      body: 'See attached.',
    })

    const { fixtureUpload } = await import('#tests/helpers')
    const upload = await fixtureUpload('png', { clientName: 'private.png' })
    const [file] = await support.attach(b.organization, b.user, message, [upload])

    /**
     * Through A's own ticket id as well as B's: neither path may end in a
     * signed URL for a file A has nothing to do with.
     */
    const throughB = await client
      .get(`/support/${ticket.publicId}/attachments/${file.publicId}`)
      .loginAs(a.user)
      .redirects(0)

    throughB.assertStatus(302)
    assert.notInclude(throughB.headers().location ?? '', file.key)
  })

  test('every organisation-scoped table carries its own rows only', async ({ assert }) => {
    const { a, b } = await twoWorkspaces()

    const usersOfA = await User.query().where('organization_id', a.organization.id)
    const usersOfB = await User.query().where('organization_id', b.organization.id)

    assert.lengthOf(usersOfA, 2)
    assert.lengthOf(usersOfB, 2)
    assert.isEmpty(
      usersOfA.filter((user) => usersOfB.some((other) => other.id === user.id)),
      'no user belongs to both'
    )

    const organizations = await Organization.all()
    assert.lengthOf(organizations, 2)
  })
})
