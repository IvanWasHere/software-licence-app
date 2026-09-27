import { createHash } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'

import LicenseFlag from '#models/license_flag'
import LicenseEvent from '#models/license_event'
import LicenseActivation from '#models/license_activation'
import traffic, { utcDay } from '#licensing/traffic'
import abuseJob from '#queue/jobs/detect_license_abuse_job'
import { createLicense, createStaff, queuedMails, queuedMailsTo } from '#tests/helpers'

/**
 * License API traffic and abuse flags (licence plan §8, §9, M8).
 */
async function sightings(licenseId: number, count: number, day = utcDay()) {
  await db.table('license_ip_days').multiInsert(
    Array.from({ length: count }, (_, index) => ({
      license_id: licenseId,
      day,
      ip_hash: createHash('sha256').update(`${licenseId}-${day}-${index}`).digest('hex'),
    }))
  )
}

test.group('License API traffic', (group) => {
  group.each.setup(async () => {
    traffic.reset()
    return testUtils.db().truncate()
  })

  test('counts calls per product and endpoint, refusals apart, across flushes', async ({
    client,
    assert,
  }) => {
    const { key, product } = await createLicense()

    await client.post('/api/v1/licenses/validate').json({ product: product.slug, license_key: key })
    await client
      .post('/api/v1/licenses/validate')
      .json({ product: product.slug, license_key: 'WIPRO-NOPE' })
    await client
      .post('/api/v1/licenses/activate')
      .json({ product: product.slug, license_key: key, instance_id: 'site-1' })
    await traffic.flush()

    await client.post('/api/v1/licenses/validate').json({ product: product.slug, license_key: key })
    await traffic.flush()

    const rows = await db
      .from('license_api_days')
      .where('product_id', product.id)
      .orderBy('endpoint')

    assert.deepEqual(
      rows.map((row) => [row.endpoint, Number(row.requests), Number(row.refused)]),
      [
        ['activate', 1, 0],
        ['validate', 3, 1],
      ]
    )
    assert.equal(rows[0].day, utcDay())
  })

  /**
   * A counter keyed by whatever slug a caller sends would be a free write
   * endpoint.
   */
  test('does not count products that do not exist', async ({ client, assert }) => {
    await client
      .post('/api/v1/licenses/validate')
      .json({ product: 'no-such-thing', license_key: 'x' })
    await traffic.flush()

    assert.lengthOf(await db.from('license_api_days'), 0)
  })

  test('records each address once a day, hashed, never the address', async ({ client, assert }) => {
    const { key, product, license } = await createLicense()

    for (let i = 0; i < 3; i++) {
      await client
        .post('/api/v1/licenses/validate')
        .json({ product: product.slug, license_key: key })
    }
    await traffic.flush()

    const rows = await db.from('license_ip_days').where('license_id', license.id)
    assert.lengthOf(rows, 1)
    assert.match(rows[0].ip_hash, /^[0-9a-f]{64}$/)
    assert.notInclude(rows[0].ip_hash, '127.0.0.1')
  })
})

test.group('Abuse flags', (group) => {
  group.each.setup(async () => {
    traffic.reset()
    return testUtils.db().truncate()
  })

  test('flags a key seen from too many addresses, tells admins, changes nothing', async ({
    assert,
  }) => {
    const admin = await createStaff({ role: 'admin' })
    const support = await createStaff({ role: 'support' })
    const disabled = await createStaff({ role: 'admin', disabled: true })
    const { license, product } = await createLicense()
    await sightings(license.id, 25)

    await abuseJob.handle()

    const flags = await LicenseFlag.query().where('license_id', license.id)
    assert.lengthOf(flags, 1)
    assert.equal(flags[0].kind, 'many_ips')
    assert.deepEqual(flags[0].details, { count: 25, allowance: 20 })

    const events = await LicenseEvent.query()
      .where('license_id', license.id)
      .where('type', 'flagged')
    assert.lengthOf(events, 1)

    const mails = await queuedMailsTo(admin.email)
    assert.lengthOf(mails, 1)
    assert.equal(mails[0].subject, 'A license was flagged for review')
    assert.include(mails[0].text, product.name)
    assert.include(mails[0].text, `/admin/licenses/${license.publicId}`)
    assert.lengthOf(await queuedMailsTo(support.email), 0)
    assert.lengthOf(await queuedMailsTo(disabled.email), 0)

    await license.refresh()
    assert.equal(license.status, 'active', 'never suspended automatically')
  })

  test('raises a finding once a day, even after it is resolved', async ({ assert }) => {
    await createStaff({ role: 'admin' })
    const { license } = await createLicense()
    await sightings(license.id, 25)

    await abuseJob.handle()
    const flag = await LicenseFlag.findByOrFail('license_id', license.id)
    flag.resolvedAt = DateTime.utc()
    await flag.save()

    await abuseJob.handle()

    assert.lengthOf(await LicenseFlag.query().where('license_id', license.id), 1)
    assert.lengthOf(await queuedMails(), 1, 'one email, not one an hour')
  })

  test('flags installations churning on a small license', async ({ assert }) => {
    const { license } = await createLicense({ plan: { maxActivations: 1 } })

    for (let i = 0; i < 11; i++) {
      await LicenseActivation.create({
        licenseId: license.id,
        instanceId: `copy-${i}`,
        isDev: false,
        activatedAt: DateTime.utc(),
        deactivatedAt: DateTime.utc(),
      })
    }

    await abuseJob.handle()

    const flag = await LicenseFlag.findByOrFail('license_id', license.id)
    assert.equal(flag.kind, 'activation_churn')
  })

  test('a big license being busy is not flagged', async ({ assert }) => {
    const { license } = await createLicense({ plan: { maxActivations: 50 } })
    await sightings(license.id, 120)

    await abuseJob.handle()

    assert.lengthOf(await LicenseFlag.all(), 0)
  })

  test('prunes address sightings past the retention window', async ({ assert }) => {
    const { license } = await createLicense()
    await sightings(license.id, 2, utcDay(DateTime.utc().minus({ days: 40 })))
    await sightings(license.id, 2)

    await abuseJob.handle()

    const left = await db.from('license_ip_days').where('license_id', license.id)
    assert.lengthOf(left, 2)
  })
})

test.group('Abuse flags — back-office', (group) => {
  group.each.setup(async () => {
    traffic.reset()
    return testUtils.db().truncate()
  })

  test('flagged licenses are listed, shown, and support can resolve them', async ({
    client,
    assert,
  }) => {
    const support = await createStaff({ role: 'support' })
    const { license } = await createLicense()
    await createLicense()
    await sightings(license.id, 25)
    await abuseJob.handle()
    const flag = await LicenseFlag.findByOrFail('license_id', license.id)

    const list = await client.get('/admin/licenses?flagged=1').withGuard('staff').loginAs(support)
    list.assertTextIncludes(license.publicId)
    list.assertTextIncludes('Flagged')
    assert.lengthOf(
      list
        .text()
        .match(/lic_[a-z0-9]+/g)!
        .filter((id, i, all) => all.indexOf(id) === i),
      1
    )

    const page = await client
      .get(`/admin/licenses/${license.publicId}`)
      .withGuard('staff')
      .loginAs(support)
    page.assertTextIncludes('Used from more addresses in a day than its size explains')
    page.assertTextIncludes('25 addresses on')

    await client
      .post(`/admin/licenses/${license.publicId}/flags/${flag.publicId}/resolve`)
      .withGuard('staff')
      .loginAs(support)
      .form({ note: 'An agency with a build farm.' })
      .withCsrfToken()
      .redirects(0)

    await flag.refresh()
    assert.isFalse(flag.isOpen)
    assert.equal(flag.resolvedByStaffId, support.id)
    assert.equal(flag.resolutionNote, 'An agency with a build farm.')

    const events = await LicenseEvent.query()
      .where('license_id', license.id)
      .where('type', 'flag_resolved')
    assert.lengthOf(events, 1)
  })

  test('the dashboard shows license API traffic and open flags', async ({ client }) => {
    const staff = await createStaff()
    const { key, product, license } = await createLicense()
    await client.post('/api/v1/licenses/validate').json({ product: product.slug, license_key: key })
    await traffic.flush()
    await sightings(license.id, 25)
    await abuseJob.handle()

    const page = await client.get('/admin').withGuard('staff').loginAs(staff)

    page.assertStatus(200)
    page.assertTextIncludes('License API')
    page.assertTextIncludes(product.name)
    page.assertTextIncludes('1 license flagged for review')
  })
})
