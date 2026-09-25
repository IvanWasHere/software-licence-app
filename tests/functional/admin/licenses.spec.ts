import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import testUtils from '@adonisjs/core/services/test_utils'

import License from '#models/license'
import AuditLog from '#models/audit_log'
import LicenseEvent from '#models/license_event'
import activations from '#licensing/activation_service'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'
import { createCatalogPlan, createLicense, createStaff, createWorkspace } from '#tests/helpers'

/**
 * The license API's answer for a key, as the reason string (`null` when
 * valid) — the one thing most assertions here care about.
 */
async function reasonFor(key: string, productSlug: string, instanceId?: string) {
  const { result } = await licenses.check(key, productSlug, instanceId)
  return result.reason
}

/**
 * Licenses in the back-office (licence plan §8, M2) and the support/admin
 * split applied to them: support unblocks, admin grants and removes.
 */
test.group('Admin licenses — access', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('support can read the list and a license', async ({ client }) => {
    const support = await createStaff({ role: 'support' })
    const { license } = await createLicense()

    for (const path of ['/admin/licenses', `/admin/licenses/${license.publicId}`]) {
      const response = await client.get(path).withGuard('staff').loginAs(support)
      response.assertStatus(200)
    }
  })

  test('support cannot issue, suspend or revoke', async ({ client, assert }) => {
    const support = await createStaff({ role: 'support' })
    const { license } = await createLicense()

    const form = await client.get('/admin/licenses/new').withGuard('staff').loginAs(support)
    form.assertStatus(403)

    for (const action of ['suspend', 'revoke']) {
      await client
        .post(`/admin/licenses/${license.publicId}/${action}`)
        .withGuard('staff')
        .loginAs(support)
        .form({ reason: 'trying my luck' })
        .withCsrfToken()
        .redirects(0)
    }

    await license.refresh()
    assert.equal(license.status, 'active')
  })

  test('support does not see the admin actions', async ({ client, assert }) => {
    const support = await createStaff({ role: 'support' })
    const { license } = await createLicense()

    const response = await client
      .get(`/admin/licenses/${license.publicId}`)
      .withGuard('staff')
      .loginAs(support)

    assert.notInclude(response.text(), 'Revoke — permanent')
    assert.include(response.text(), 'Reveal key')
  })
})

test.group('Admin licenses — issuing', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('an admin issues a license to a customer found by email', async ({ client, assert }) => {
    const admin = await createStaff()
    const { organization } = await createWorkspace({ email: 'buyer@example.com' })
    const { plan } = await createCatalogPlan()

    const response = await client
      .post('/admin/licenses')
      .withGuard('staff')
      .loginAs(admin)
      .form({ customer: 'Buyer@Example.com', plan: plan.publicId, notes: 'ticket-12' })
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)

    const license = await License.findByOrFail('organization_id', organization.id)
    assert.equal(license.planId, plan.id)
    assert.equal(license.source, 'manual')
    assert.equal(license.notes, 'ticket-12')
    response.assertHeader('location', `/admin/licenses/${license.publicId}`)

    /**
     * The key is handed to the next screen once, through the flash.
     */
    response.assertFlashMessage('revealedKey', license.keyEncrypted)

    const entry = await AuditLog.findByOrFail('action', 'license.issued')
    assert.equal(entry.organizationId, organization.id)
  })

  test('also by organisation id', async ({ client, assert }) => {
    const admin = await createStaff()
    const { organization } = await createWorkspace()
    const { plan } = await createCatalogPlan()

    await client
      .post('/admin/licenses')
      .withGuard('staff')
      .loginAs(admin)
      .form({ customer: organization.publicId, plan: plan.publicId })
      .withCsrfToken()
      .redirects(0)

    assert.lengthOf(await License.query().where('organization_id', organization.id), 1)
  })

  /**
   * Exact matches only — a half-matched name must never receive a license.
   */
  test('refuses a customer that does not match exactly', async ({ client, assert }) => {
    const admin = await createStaff()
    await createWorkspace({ email: 'buyer@example.com' })
    const { plan } = await createCatalogPlan()

    for (const customer of ['buyer', 'buyer@example', 'org_222222222222']) {
      const response = await client
        .post('/admin/licenses')
        .withGuard('staff')
        .loginAs(admin)
        .form({ customer, plan: plan.publicId })
        .withCsrfToken()
        .redirects(0)

      response.assertStatus(302)
    }

    assert.lengthOf(await License.all(), 0)
  })

  test('a subscription plan needs an expiry, reported against the field', async ({ client }) => {
    const admin = await createStaff()
    await createWorkspace({ email: 'buyer@example.com' })
    const { plan } = await createCatalogPlan({
      plan: { billing: 'yearly', licenseTerm: 'subscription' },
    })

    const response = await client
      .post('/admin/licenses')
      .withGuard('staff')
      .loginAs(admin)
      .form({ customer: 'buyer@example.com', plan: plan.publicId })
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)
    response.assertFlashMessage('inputErrorsBag', {
      expiresAt: [
        'A subscription plan issued by hand needs an expiry date — there is no subscription to say when it ends.',
      ],
    })
  })

  test('an expiry date means the end of that day', async ({ client, assert }) => {
    const admin = await createStaff()
    await createWorkspace({ email: 'buyer@example.com' })
    const { plan } = await createCatalogPlan({
      plan: { billing: 'yearly', licenseTerm: 'subscription' },
    })
    const day = DateTime.utc().plus({ days: 10 }).toISODate()!

    await client
      .post('/admin/licenses')
      .withGuard('staff')
      .loginAs(admin)
      .form({ customer: 'buyer@example.com', plan: plan.publicId, expiresAt: day })
      .withCsrfToken()
      .redirects(0)

    const license = await License.firstOrFail()
    assert.equal(license.expiresAt!.toUTC().toISO(), `${day}T23:59:59.000Z`)
  })
})

test.group('Admin licenses — search', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('finds a license by key, suffix, id or customer email', async ({ client, assert }) => {
    const admin = await createStaff()
    const { organization } = await createWorkspace({ email: 'owner@example.com' })
    const { license, key } = await createLicense({ organization })
    const other = await createLicense()

    for (const term of [
      key,
      key.toLowerCase().replace(/-/g, ''),
      license.keySuffix.toLowerCase(),
      license.publicId,
      organization.publicId,
      'owner@example.com',
    ]) {
      const response = await client
        .get(`/admin/licenses?q=${encodeURIComponent(term)}`)
        .withGuard('staff')
        .loginAs(admin)

      response.assertStatus(200)
      assert.include(response.text(), license.publicId, `searched for ${term}`)
      assert.notInclude(response.text(), other.license.publicId, `searched for ${term}`)
    }
  })

  test('the organisation screen links to its licenses', async ({ client }) => {
    const admin = await createStaff()
    const { organization } = await createWorkspace()

    const response = await client
      .get(`/admin/organizations/${organization.publicId}`)
      .withGuard('staff')
      .loginAs(admin)

    response.assertTextIncludes(`/admin/licenses?q=${organization.publicId}`)
  })

  test('filters by status', async ({ client, assert }) => {
    const admin = await createStaff()
    const { license } = await createLicense()
    const revoked = await createLicense()
    await licenses.revoke(revoked.license, 'refund', SYSTEM_ACTOR)

    const response = await client
      .get('/admin/licenses?status=revoked')
      .withGuard('staff')
      .loginAs(admin)

    assert.include(response.text(), revoked.license.publicId)
    assert.notInclude(response.text(), license.publicId)
  })
})

test.group('Admin licenses — actions', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  const post = (client: any, staff: any, path: string, form: Record<string, any> = {}) =>
    client.post(path).withGuard('staff').loginAs(staff).form(form).withCsrfToken().redirects(0)

  test('support can reveal a key, and it is recorded', async ({ client, assert }) => {
    const support = await createStaff({ role: 'support' })
    const { license, key } = await createLicense()

    const response = await post(client, support, `/admin/licenses/${license.publicId}/reveal`)

    response.assertFlashMessage('revealedKey', key)
    assert.exists(await LicenseEvent.query().where('type', 'key_revealed').first())
    assert.exists(await AuditLog.findBy('action', 'license.key_revealed'))
  })

  test('support can free an activation slot', async ({ client, assert }) => {
    const support = await createStaff({ role: 'support' })
    const { license } = await createLicense()
    const result = await activations.activate(license, { instanceId: 'site-1' }, SYSTEM_ACTOR)
    const activation = result.ok ? result.activation : null

    await post(
      client,
      support,
      `/admin/licenses/${license.publicId}/activations/${activation!.publicId}/deactivate`
    )

    assert.lengthOf(await activations.live(license), 0)
    const event = await LicenseEvent.query().where('type', 'deactivated').firstOrFail()
    assert.equal(event.actorType, 'staff')
    assert.equal(event.actorId, support.id)
  })

  test('an admin suspends with a reason and resumes', async ({ client, assert }) => {
    const admin = await createStaff()
    const { license } = await createLicense()

    await post(client, admin, `/admin/licenses/${license.publicId}/suspend`, {
      reason: 'chargeback opened',
    })
    await license.refresh()
    assert.equal(license.status, 'suspended')
    assert.equal(license.statusReason, 'chargeback opened')

    await post(client, admin, `/admin/licenses/${license.publicId}/resume`)
    await license.refresh()
    assert.equal(license.status, 'active')
    assert.isNull(license.statusReason)
  })

  test('suspending needs a reason', async ({ client, assert }) => {
    const admin = await createStaff()
    const { license } = await createLicense()

    await post(client, admin, `/admin/licenses/${license.publicId}/suspend`, { reason: '' })

    await license.refresh()
    assert.equal(license.status, 'active')
  })

  test('revoking is final', async ({ client, assert }) => {
    const admin = await createStaff()
    const { license } = await createLicense()

    await post(client, admin, `/admin/licenses/${license.publicId}/revoke`, { reason: 'refunded' })
    const resume = await post(client, admin, `/admin/licenses/${license.publicId}/resume`)

    resume.assertFlashMessage(
      'error',
      'A revoked license cannot be resumed. Issue a new one instead.'
    )
    await license.refresh()
    assert.equal(license.status, 'revoked')
  })

  test('reissuing hands over a new key once', async ({ client, assert }) => {
    const admin = await createStaff()
    const { license, key, product } = await createLicense()

    const response = await post(client, admin, `/admin/licenses/${license.publicId}/reissue`)

    await license.refresh()
    assert.notEqual(license.keyEncrypted, key)
    response.assertFlashMessage('revealedKey', license.keyEncrypted)
    assert.equal(await reasonFor(key, product.slug), 'invalid_license')
  })

  test('an admin changes the expiry and the activation limit', async ({ client, assert }) => {
    const admin = await createStaff()
    const { license } = await createLicense()
    const day = DateTime.utc().plus({ months: 2 }).toISODate()!

    await post(client, admin, `/admin/licenses/${license.publicId}/expiry`, { expiresAt: day })
    await post(client, admin, `/admin/licenses/${license.publicId}/activations-limit`, {
      maxActivations: '10',
    })

    await license.refresh()
    assert.equal(license.expiresAt!.toUTC().toISODate(), day)
    assert.equal(license.maxActivations, 10)

    await post(client, admin, `/admin/licenses/${license.publicId}/expiry`, { expiresAt: '' })
    await post(client, admin, `/admin/licenses/${license.publicId}/activations-limit`, {
      maxActivations: '',
    })

    await license.refresh()
    assert.isNull(license.expiresAt)
    assert.isNull(license.maxActivations)
  })

  test('the license screen shows activations, entitlements and history', async ({ client }) => {
    const admin = await createStaff()
    const { license } = await createLicense()
    await activations.activate(
      license,
      { instanceId: 'site-1', siteUrl: 'https://shop.example.com', clientVersion: '1.2.0' },
      SYSTEM_ACTOR
    )

    const response = await client
      .get(`/admin/licenses/${license.publicId}`)
      .withGuard('staff')
      .loginAs(admin)

    response.assertStatus(200)
    response.assertTextIncludes('shop.example.com')
    response.assertTextIncludes('1.2.0')
    response.assertTextIncludes('1 of 3 in use')
    response.assertTextIncludes('activated')
  })
})
