import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'

import LicenseEvent from '#models/license_event'
import catalog from '#catalog/catalog_service'
import licenses, { LicenseError, SYSTEM_ACTOR } from '#licensing/license_service'
import activations from '#licensing/activation_service'
import { createCatalogPlan, createLicense, createWorkspace } from '#tests/helpers'

/**
 * The license API's answer for a key, as the reason string (`null` when
 * valid) — the one thing most assertions here care about.
 */
async function reasonFor(key: string, productSlug: string, instanceId?: string) {
  const { result } = await licenses.check(key, productSlug, instanceId)
  return result.reason
}

/**
 * Issuing licenses and answering whether one is valid (licence plan §5),
 * against a real database.
 */
test.group('Licenses — issuing', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('a perpetual plan issues a license that never expires', async ({ assert }) => {
    const { license, key, product } = await createLicense({ plan: { updatesDays: 365 } })

    assert.isNull(license.expiresAt)
    assert.isTrue(license.isPerpetual)
    assert.isTrue(key.startsWith(`${product.keyPrefix}-`))
    assert.equal(license.keySuffix, key.slice(-4))
    assert.equal(license.maxActivations, 3)
    assert.approximately(
      license.updatesUntil!.toMillis(),
      DateTime.utc().plus({ days: 365 }).toMillis(),
      5_000
    )
  })

  /**
   * The plaintext key is only held encrypted, and the lookup column is a
   * hash of its body — a dump of `key_hash` alone unlocks nothing.
   */
  test('stores the key encrypted and looks it up by hash', async ({ assert }) => {
    const { license, key } = await createLicense()
    const row = await db.from('licenses').where('id', license.id).first()

    assert.notInclude(String(row.key_encrypted), key)
    assert.notInclude(String(row.key_hash), key)
    assert.equal(await licenses.revealKey(license, SYSTEM_ACTOR), key)
  })

  test('a fixed-length plan expires after its term', async ({ assert }) => {
    const { license } = await createLicense({
      plan: { licenseTerm: 'fixed_days', termDays: 30 },
    })

    assert.approximately(
      license.expiresAt!.toMillis(),
      DateTime.utc().plus({ days: 30 }).toMillis(),
      5_000
    )
  })

  test('a subscription plan issued by hand needs an expiry date', async ({ assert }) => {
    const { organization } = await createWorkspace()
    const { plan } = await createCatalogPlan({
      plan: { billing: 'yearly', licenseTerm: 'subscription' },
    })

    await assert.rejects(
      () => licenses.issue({ organization, plan, source: 'manual', actor: SYSTEM_ACTOR }),
      LicenseError
    )

    const { license } = await licenses.issue({
      organization,
      plan,
      source: 'manual',
      actor: SYSTEM_ACTOR,
      expiresAt: DateTime.utc().plus({ years: 1 }),
    })
    assert.isFalse(license.isExpired)
  })

  test('an archived plan issues nothing', async ({ assert }) => {
    const { organization } = await createWorkspace()
    const { plan } = await createCatalogPlan()
    await catalog.setPlanArchived(plan, true)

    await assert.rejects(
      () => licenses.issue({ organization, plan, source: 'manual', actor: SYSTEM_ACTOR }),
      LicenseError
    )
  })

  /**
   * Editing a plan changes what the next customer buys, never what an
   * existing one already has.
   */
  test('copies the activation limit, so a plan edit changes nothing issued', async ({ assert }) => {
    const { license, plan } = await createLicense()
    plan.maxActivations = 1
    await plan.save()

    await license.refresh()
    assert.equal(license.maxActivations, 3)
  })

  test('records the issue in the license history', async ({ assert }) => {
    const { license } = await createLicense()
    const events = await LicenseEvent.query().where('license_id', license.id)

    assert.deepEqual(
      events.map((event) => event.type),
      ['issued']
    )
  })
})

test.group('Licenses — checking', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('a good key for its product is valid', async ({ assert }) => {
    const { key, product } = await createLicense()

    const { result } = await licenses.check(key, product.slug)
    assert.deepEqual(result, { valid: true, reason: null })
  })

  test('is forgiving about how the key is typed', async ({ assert }) => {
    const { key, product } = await createLicense()

    const { result } = await licenses.check(
      ` ${key.toLowerCase().replace(/-/g, '')} `,
      product.slug
    )
    assert.isTrue(result.valid)
  })

  test('an unknown or malformed key is invalid_license', async ({ assert }) => {
    const { product } = await createLicense()

    for (const key of ['WIPRO-AAAAA-AAAAA-AAAAA-AAAAA', 'nonsense', null]) {
      const { result, license } = await licenses.check(key, product.slug)
      assert.equal(result.reason, 'invalid_license')
      assert.isNull(license)
    }
  })

  test('a key for another product is product_mismatch', async ({ assert }) => {
    const { key } = await createLicense()
    const { product: other } = await createCatalogPlan()

    const { result } = await licenses.check(key, other.slug)
    assert.equal(result.reason, 'product_mismatch')
  })

  test('suspend, resume and revoke move the answer', async ({ assert }) => {
    const { license, key, product } = await createLicense()

    await licenses.suspend(license, 'chargeback under review', SYSTEM_ACTOR)
    assert.equal(await reasonFor(key, product.slug), 'license_suspended')

    await licenses.resume(license, SYSTEM_ACTOR)
    assert.isNull(await reasonFor(key, product.slug))

    await licenses.revoke(license, 'refunded', SYSTEM_ACTOR)
    assert.equal(await reasonFor(key, product.slug), 'license_revoked')

    await assert.rejects(() => licenses.resume(license, SYSTEM_ACTOR), LicenseError)

    const history = await licenses.history(license)
    const types = history.map((event) => event.type)
    assert.deepEqual(types, ['revoked', 'resumed', 'suspended', 'issued'])
  })

  test('an expired license is license_expired, and extending fixes it', async ({ assert }) => {
    const { license, key, product } = await createLicense({
      plan: { licenseTerm: 'fixed_days', termDays: 30 },
    })

    await licenses.changeExpiry(license, DateTime.utc().minus({ minutes: 1 }), SYSTEM_ACTOR)
    assert.equal(await reasonFor(key, product.slug), 'license_expired')

    await licenses.changeExpiry(license, DateTime.utc().plus({ days: 30 }), SYSTEM_ACTOR)
    assert.isNull(await reasonFor(key, product.slug))
  })

  test('with an instance id, the instance must be activated', async ({ assert }) => {
    const { license, key, product } = await createLicense()

    const before = await licenses.check(key, product.slug, 'instance-1')
    assert.equal(before.result.reason, 'not_activated')

    await activations.activate(license, { instanceId: 'instance-1' }, SYSTEM_ACTOR)

    const after = await licenses.check(key, product.slug, 'instance-1')
    assert.isTrue(after.result.valid)
    assert.equal(after.activation!.instanceId, 'instance-1')
  })

  /**
   * A reissued key replaces the old one immediately, and keeps the
   * customer's activations.
   */
  test('reissuing a key retires the old one and keeps activations', async ({ assert }) => {
    const { license, key, product } = await createLicense()
    await activations.activate(license, { instanceId: 'site-a' }, SYSTEM_ACTOR)

    const { key: newKey } = await licenses.reissueKey(license, SYSTEM_ACTOR)

    assert.notEqual(newKey, key)
    assert.equal(await reasonFor(key, product.slug), 'invalid_license')
    assert.isNull(await reasonFor(newKey, product.slug, 'site-a'))
  })

  test('resolves entitlements from plan and license overrides', async ({ assert }) => {
    const { license, product, plan } = await createLicense()
    await catalog.createEntitlement(product, { key: 'pdf_export', name: 'PDF', type: 'boolean' })
    await catalog.createEntitlement(product, {
      key: 'seats',
      name: 'Seats',
      type: 'integer',
      defaultValue: '1',
    })
    await catalog.setPlanEntitlements(product, plan, { pdf_export: '1' })

    assert.deepEqual(await licenses.entitlements(license), { pdf_export: true, seats: 1 })

    license.entitlementOverrides = { seats: 10 }
    await license.save()
    assert.deepEqual(await licenses.entitlements(license), { pdf_export: true, seats: 10 })
  })
})

test.group('Licenses — activations', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('activating is idempotent per instance', async ({ assert }) => {
    const { license } = await createLicense()

    const first = await activations.activate(
      license,
      { instanceId: 'i-1', siteUrl: 'https://www.shop.example.com/' },
      SYSTEM_ACTOR
    )
    const again = await activations.activate(license, { instanceId: 'i-1' }, SYSTEM_ACTOR)

    assert.isTrue(first.ok && first.created)
    assert.isTrue(again.ok && !again.created)
    assert.deepEqual(await activations.usage(license), { used: 1, max: 3 })
    assert.equal(first.ok && first.activation.hostname, 'shop.example.com')
  })

  test('refuses past the limit and says how many are in use', async ({ assert }) => {
    const { license } = await createLicense({ plan: { maxActivations: 2 } })

    await activations.activate(license, { instanceId: 'a' }, SYSTEM_ACTOR)
    await activations.activate(license, { instanceId: 'b' }, SYSTEM_ACTOR)
    const third = await activations.activate(license, { instanceId: 'c' }, SYSTEM_ACTOR)

    assert.deepEqual(third, { ok: false, reason: 'activation_limit_reached', used: 2, max: 2 })
  })

  test('an unlimited plan never refuses', async ({ assert }) => {
    const { license } = await createLicense({ plan: { maxActivations: null } })

    for (const instanceId of ['a', 'b', 'c', 'd', 'e']) {
      const result = await activations.activate(license, { instanceId }, SYSTEM_ACTOR)
      assert.isTrue(result.ok, instanceId)
    }
  })

  test('development sites are free unless the product counts them', async ({ assert }) => {
    const { license } = await createLicense({ plan: { maxActivations: 1 } })

    await activations.activate(
      license,
      { instanceId: 'prod', siteUrl: 'example.com' },
      SYSTEM_ACTOR
    )
    const staging = await activations.activate(
      license,
      { instanceId: 'staging', siteUrl: 'https://staging.example.com' },
      SYSTEM_ACTOR
    )
    const local = await activations.activate(
      license,
      { instanceId: 'local', siteUrl: 'http://localhost:8080' },
      SYSTEM_ACTOR
    )

    assert.isTrue(staging.ok && staging.activation.isDev)
    assert.isTrue(local.ok)
    assert.deepEqual(await activations.usage(license), { used: 1, max: 1 })

    const counted = await createLicense({
      plan: { maxActivations: 1 },
      product: { countDevSites: true },
    })
    await activations.activate(
      counted.license,
      { instanceId: 'x', siteUrl: 'localhost' },
      SYSTEM_ACTOR
    )
    const refused = await activations.activate(
      counted.license,
      { instanceId: 'y', siteUrl: 'example.com' },
      SYSTEM_ACTOR
    )
    assert.isFalse(refused.ok)
  })

  test('deactivating frees the slot, and coming back reuses the row', async ({ assert }) => {
    const { license } = await createLicense({ plan: { maxActivations: 1 } })

    const first = await activations.activate(license, { instanceId: 'a' }, SYSTEM_ACTOR)
    assert.isTrue(await activations.deactivate(license, 'a', SYSTEM_ACTOR))
    assert.isFalse(await activations.deactivate(license, 'a', SYSTEM_ACTOR))

    const other = await activations.activate(license, { instanceId: 'b' }, SYSTEM_ACTOR)
    assert.isTrue(other.ok)
    await activations.deactivate(license, 'b', SYSTEM_ACTOR)

    const back = await activations.activate(license, { instanceId: 'a' }, SYSTEM_ACTOR)
    assert.isTrue(back.ok)
    assert.equal(back.ok && back.activation.id, first.ok && first.activation.id)

    const all = await activations.all(license)
    assert.lengthOf(all, 2)

    const history = await licenses.history(license)
    const types = history.map((event) => event.type)
    assert.includeMembers(types, ['activated', 'deactivated', 'reactivated'])
  })

  /**
   * Lowering a limit below what is in use switches nobody's site off; it
   * only refuses the next one.
   */
  test('lowering the limit keeps current activations', async ({ assert }) => {
    const { license } = await createLicense()
    await activations.activate(license, { instanceId: 'a' }, SYSTEM_ACTOR)
    await activations.activate(license, { instanceId: 'b' }, SYSTEM_ACTOR)

    await licenses.setMaxActivations(license, 1, SYSTEM_ACTOR)

    assert.lengthOf(await activations.live(license), 2)
    const refused = await activations.activate(license, { instanceId: 'c' }, SYSTEM_ACTOR)
    assert.isFalse(refused.ok)
  })

  /**
   * Parallel activations for the last slot. On SQLite writes are serialised
   * so this passes regardless; on the Postgres leg of CI it is what proves
   * the row lock is there (CONTRIBUTING, trap 4).
   */
  test('two installs racing for the last slot cannot both win', async ({ assert }) => {
    const { license } = await createLicense({ plan: { maxActivations: 1 } })

    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((instanceId) =>
        activations.activate(license, { instanceId }, SYSTEM_ACTOR)
      )
    )

    assert.lengthOf(
      results.filter((result) => result.ok),
      1
    )
    assert.lengthOf(await activations.live(license), 1)
  })
})
