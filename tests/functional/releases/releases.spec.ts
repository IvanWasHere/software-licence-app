import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import testUtils from '@adonisjs/core/services/test_utils'

import signer from '#licensing/signer'
import Release from '#models/release'
import AuditLog from '#models/audit_log'
import activations from '#licensing/activation_service'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'
import {
  clearStorage,
  createLicense,
  createRelease,
  createStaff,
  createWorkspaceWithFeatures,
  fixtureUpload,
  zipFixture,
} from '#tests/helpers'

/**
 * Updates (licence plan §6, M7): what `releases/latest` offers, to whom, and
 * the link it hands over.
 */
async function activeProduct(options: Parameters<typeof createLicense>[0] = {}) {
  const created = await createLicense(options)
  created.product.status = 'active'
  await created.product.save()
  return created
}

function latestUrl(slug: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString()
  return `/api/v1/products/${slug}/releases/latest${qs ? `?${qs}` : ''}`
}

test.group('Releases API — latest', (group) => {
  group.each.setup(async () => {
    await clearStorage()
    return testUtils.db().truncate()
  })

  test('describes the newest build and links a licensed caller to it', async ({
    client,
    assert,
  }) => {
    const { product, key, license } = await activeProduct()
    await createRelease(product, { version: '1.2.0' })
    const newest = await createRelease(product, { version: '1.10.0' })
    await createRelease(product, { version: '2.0.0-beta.1', channel: 'beta' })

    const response = await client.get(
      latestUrl(product.slug, { license_key: key, nonce: 'nonce-12345' })
    )

    response.assertStatus(200)
    response.assertBodyContains({
      release: {
        id: newest.publicId,
        version: '1.10.0',
        channel: 'stable',
        requires: { wp: '6.5', php: '7.4' },
        tested_up_to: '6.8',
        checksum_sha256: newest.checksum,
      },
      update_allowed: true,
      reason: null,
      license: { id: license.publicId },
      product: product.slug,
      nonce: 'nonce-12345',
    })

    const download = response.body().download
    assert.match(download.url, /^http.+\/api\/v1\/releases\/rel_[^/]+\/download\?.*signature=/)
    assert.include(download.url, `license=${license.publicId}`)

    /**
     * Signed like every other license API answer, link included — a client
     * trusts the checksum and the URL only from the verified payload.
     */
    const signed = response.body().signed
    assert.isNotNull(signer.verify(signed))
    const payload = JSON.parse(Buffer.from(signed.payload, 'base64url').toString('utf8'))
    assert.equal(payload.release.checksum_sha256, newest.checksum)
    assert.equal(payload.download.url, download.url)
  })

  test('the beta channel is offered betas', async ({ client }) => {
    const { product, key } = await activeProduct()
    await createRelease(product, { version: '1.0.0' })
    await createRelease(product, { version: '2.0.0-beta.1', channel: 'beta' })

    const response = await client.get(
      latestUrl(product.slug, { license_key: key, channel: 'beta' })
    )

    response.assertBodyContains({ release: { version: '2.0.0-beta.1' } })
  })

  test('without a key, a licensed build is described but not linked', async ({ client }) => {
    const { product } = await activeProduct()
    await createRelease(product, { version: '1.0.0' })

    const response = await client.get(latestUrl(product.slug))

    response.assertStatus(200)
    response.assertBodyContains({
      release: { version: '1.0.0' },
      update_allowed: false,
      reason: 'license_required',
      download: null,
      license: null,
    })
  })

  test('a free build is linked to anybody', async ({ client, assert }) => {
    const { product } = await activeProduct()
    await createRelease(product, { version: '1.0.0', licenseRequired: false })

    const response = await client.get(latestUrl(product.slug))

    response.assertBodyContains({ update_allowed: true, reason: null })
    assert.notInclude(response.body().download.url, 'license=')
  })

  test('an expired or revoked license gets its reason and no link', async ({ client }) => {
    const { product, key, license } = await activeProduct()
    await createRelease(product, { version: '1.0.0' })
    await licenses.revoke(license, 'refund', SYSTEM_ACTOR)

    const response = await client.get(latestUrl(product.slug, { license_key: key }))

    response.assertBodyContains({
      update_allowed: false,
      reason: 'license_revoked',
      download: null,
    })
  })

  /**
   * Plan Q4: a perpetual license whose updates ran out is still valid — the
   * software keeps working — but is not given builds from after its window.
   */
  test('an update window that closed before the build is `updates_expired`', async ({ client }) => {
    const { product, key, license } = await activeProduct()
    license.updatesUntil = DateTime.utc().minus({ days: 30 })
    await license.save()

    await createRelease(product, {
      version: '1.0.0',
      publishedAt: DateTime.utc().minus({ days: 60 }),
    })
    await createRelease(product, { version: '1.1.0' })

    const response = await client.get(latestUrl(product.slug, { license_key: key }))

    response.assertBodyContains({
      release: { version: '1.1.0' },
      update_allowed: false,
      reason: 'updates_expired',
      download: null,
    })

    const validate = await client
      .post('/api/v1/licenses/validate')
      .json({ product: product.slug, license_key: key })
    validate.assertBodyContains({ valid: true })
  })

  test('with an instance, it must be activated there, and it counts as a heartbeat', async ({
    client,
    assert,
  }) => {
    const { product, key, license } = await activeProduct()
    await createRelease(product, { version: '1.0.0' })

    const before = await client.get(
      latestUrl(product.slug, { license_key: key, instance_id: 'site-1' })
    )
    before.assertBodyContains({
      update_allowed: false,
      reason: 'not_activated',
      instance_id: 'site-1',
    })

    const outcome = await activations.activate(license, { instanceId: 'site-1' }, SYSTEM_ACTOR)
    assert.isTrue(outcome.ok)

    const after = await client.get(
      latestUrl(product.slug, { license_key: key, instance_id: 'site-1' })
    )
    after.assertBodyContains({ update_allowed: true })
  })

  test("another product's key does not unlock this one", async ({ client }) => {
    const { product } = await activeProduct()
    const other = await activeProduct()
    await createRelease(product, { version: '1.0.0' })

    const response = await client.get(latestUrl(product.slug, { license_key: other.key }))

    response.assertBodyContains({
      update_allowed: false,
      reason: 'product_mismatch',
      license: null,
    })
  })

  test('no releases is an answer, not an error', async ({ client }) => {
    const { product, key } = await activeProduct()
    await createRelease(product, { version: '1.0.0', publish: false })

    const response = await client.get(latestUrl(product.slug, { license_key: key }))

    response.assertStatus(200)
    response.assertBodyContains({ release: null, update_allowed: false, download: null })
  })

  test('a draft product does not exist', async ({ client }) => {
    const { product } = await createLicense()

    const response = await client.get(latestUrl(product.slug))

    response.assertStatus(404)
  })
})

test.group('Releases API — download', (group) => {
  group.each.setup(async () => {
    await clearStorage()
    return testUtils.db().truncate()
  })

  test('a fresh link redirects to the build', async ({ client, assert }) => {
    const { product, key } = await activeProduct()
    const release = await createRelease(product, { version: '1.0.0' })

    const latest = await client.get(latestUrl(product.slug, { license_key: key }))
    const response = await client.get(pathOf(latest.body().download.url)).redirects(0)

    response.assertStatus(302)

    /**
     * The storage URL alone — this link's own query must not ride along, or
     * it breaks the storage URL's signature.
     */
    const location = response.header('location') ?? ''
    assert.notInclude(location, 'license=')
    assert.lengthOf(location.match(/\?/g) ?? [], 1)

    const file = await client.get(location)
    file.assertStatus(200)
    assert.equal(Number(file.header('content-length')), release.fileSize)
    assert.include(file.header('content-disposition'), release.fileName)
  })

  test('a tampered link is refused', async ({ client }) => {
    const { product, key } = await activeProduct()
    await createRelease(product, { version: '1.0.0' })

    const latest = await client.get(latestUrl(product.slug, { license_key: key }))
    const url = pathOf(latest.body().download.url).replace(/license=lic_[^&]+/, 'license=lic_other')
    const response = await client.get(url).redirects(0)

    response.assertStatus(403)
    response.assertBodyContains({ error: { code: 'forbidden' } })
  })

  test('an unsigned link is refused', async ({ client }) => {
    const { product } = await activeProduct()
    const release = await createRelease(product, { version: '1.0.0' })

    const response = await client.get(`/api/v1/releases/${release.publicId}/download`).redirects(0)

    response.assertStatus(403)
  })

  test('a license revoked after the link was issued gets nothing', async ({ client }) => {
    const { product, key, license } = await activeProduct()
    await createRelease(product, { version: '1.0.0' })

    const latest = await client.get(latestUrl(product.slug, { license_key: key }))
    await licenses.revoke(license, 'refund', SYSTEM_ACTOR)

    const response = await client.get(pathOf(latest.body().download.url)).redirects(0)

    response.assertStatus(403)
    response.assertBodyContains({ error: { details: { reason: 'license_revoked' } } })
  })
})

test.group('Releases — back-office', (group) => {
  group.each.setup(async () => {
    await clearStorage()
    return testUtils.db().truncate()
  })

  test('an admin uploads a draft, publishes it and withdraws it', async ({ client, assert }) => {
    const staff = await createStaff()
    const { product } = await activeProduct()
    const upload = await fixtureUpload('txt', { bytes: zipFixture() })

    const stored = await client
      .post(`/admin/products/${product.publicId}/releases`)
      .withGuard('staff')
      .loginAs(staff)
      .withCsrfToken()
      .fields({ version: 'v1.4.0', channel: 'stable', requiresWp: '6.5', licenseRequired: '1' })
      .file('file', upload.tmpPath, { filename: 'build.zip' })
      .redirects(0)

    stored.assertStatus(302)

    const release = await Release.findByOrFail('product_id', product.id)
    assert.equal(release.version, '1.4.0', 'the leading v is dropped')
    assert.equal(release.status, 'draft')
    assert.isTrue(release.licenseRequired)
    assert.deepEqual(release.requires, { wp: '6.5' })
    assert.equal(release.fileSize, zipFixture().length)
    assert.match(
      release.fileKey,
      new RegExp(`^releases/${product.publicId}/1\\.4\\.0/[0-9a-f-]+\\.zip$`)
    )

    await client
      .post(`/admin/products/${product.publicId}/releases/${release.publicId}/publish`)
      .withGuard('staff')
      .loginAs(staff)
      .withCsrfToken()
      .redirects(0)
    await release.refresh()
    assert.equal(release.status, 'published')
    assert.isNotNull(release.publishedAt)
    const publishedAt = release.publishedAt!.toMillis()

    await client
      .post(`/admin/products/${product.publicId}/releases/${release.publicId}/yank`)
      .withGuard('staff')
      .loginAs(staff)
      .withCsrfToken()
      .redirects(0)
    await release.refresh()
    assert.equal(release.status, 'yanked')

    /**
     * Restoring keeps the original date — it is what update windows are
     * measured against.
     */
    await client
      .post(`/admin/products/${product.publicId}/releases/${release.publicId}/publish`)
      .withGuard('staff')
      .loginAs(staff)
      .withCsrfToken()
      .redirects(0)
    await release.refresh()
    assert.equal(release.publishedAt!.toMillis(), publishedAt)

    const logs = await AuditLog.query().orderBy('id', 'asc')
    const actions = logs.map((log) => log.action)
    assert.includeMembers(actions, [
      'catalog.release.uploaded',
      'catalog.release.published',
      'catalog.release.yanked',
    ])

    const page = await client
      .get(`/admin/products/${product.publicId}`)
      .withGuard('staff')
      .loginAs(staff)
    page.assertStatus(200)
    page.assertTextIncludes('1.4.0')
  })

  test('refuses a file that is not a zip, and a version that already exists', async ({
    client,
    assert,
  }) => {
    const staff = await createStaff()
    const { product } = await activeProduct()
    await createRelease(product, { version: '1.0.0' })

    const notZip = await fixtureUpload('pdf')
    const refused = await client
      .post(`/admin/products/${product.publicId}/releases`)
      .withGuard('staff')
      .loginAs(staff)
      .withCsrfToken()
      .fields({ version: '1.1.0', channel: 'stable' })
      .file('file', notZip.tmpPath, { filename: 'build.zip' })
      .redirects(0)
    refused.assertStatus(302)
    refused.assertFlashMessage('inputErrorsBag', { file: ['A build must be a .zip file.'] })

    const zip = await fixtureUpload('txt', { bytes: zipFixture() })
    const duplicate = await client
      .post(`/admin/products/${product.publicId}/releases`)
      .withGuard('staff')
      .loginAs(staff)
      .withCsrfToken()
      .fields({ version: '1.0.0', channel: 'stable' })
      .file('file', zip.tmpPath, { filename: 'build.zip' })
      .redirects(0)
    duplicate.assertStatus(302)

    const stored = await Release.query().where('product_id', product.id)
    assert.lengthOf(stored, 1)
  })

  test('support can see releases but not change them', async ({ client, assert }) => {
    const staff = await createStaff({ role: 'support' })
    const { product } = await activeProduct()
    const release = await createRelease(product, { version: '1.0.0', publish: false })

    const page = await client
      .get(`/admin/products/${product.publicId}`)
      .withGuard('staff')
      .loginAs(staff)
    page.assertTextIncludes('1.0.0')

    const publish = await client
      .post(`/admin/products/${product.publicId}/releases/${release.publicId}/publish`)
      .withGuard('staff')
      .loginAs(staff)
      .withCsrfToken()
      .redirects(0)
    publish.assertStatus(302)
    await release.refresh()
    assert.equal(release.status, 'draft')
    assert.notInclude(page.text(), 'Upload a release')
  })

  test('a draft can be deleted, file and all; a published build cannot', async ({
    client,
    assert,
  }) => {
    const staff = await createStaff()
    const { product } = await activeProduct()
    const draft = await createRelease(product, { version: '1.0.0', publish: false })
    const published = await createRelease(product, { version: '1.1.0' })

    for (const release of [draft, published]) {
      await client
        .post(`/admin/products/${product.publicId}/releases/${release.publicId}/delete`)
        .withGuard('staff')
        .loginAs(staff)
        .withCsrfToken()
        .redirects(0)
    }

    const remaining = await Release.query().where('product_id', product.id)
    assert.deepEqual(
      remaining.map((release) => release.version),
      ['1.1.0']
    )
  })
})

function pathOf(url: string): string {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}

test.group('Releases — customer portal', (group) => {
  group.each.setup(async () => {
    await clearStorage()
    return testUtils.db().truncate()
  })

  test('a customer sees the latest version and downloads it', async ({ client, assert }) => {
    const { user, organization } = await createWorkspaceWithFeatures()
    const { product, license } = await activeProduct({ organization })
    await createRelease(product, { version: '1.3.0' })

    const page = await client.get(`/licenses/${license.publicId}`).loginAs(user)
    page.assertTextIncludes('1.3.0')
    page.assertTextIncludes('Download .zip')

    const download = await client
      .get(`/licenses/${license.publicId}/download`)
      .loginAs(user)
      .redirects(0)
    download.assertStatus(302)
    assert.include(download.header('location'), 'signature=')
  })

  test('an update window that closed is explained, and the download refused', async ({
    client,
  }) => {
    const { user, organization } = await createWorkspaceWithFeatures()
    const { product, license } = await activeProduct({ organization })
    license.updatesUntil = DateTime.utc().minus({ days: 1 })
    await license.save()
    await createRelease(product, { version: '2.0.0' })

    const page = await client.get(`/licenses/${license.publicId}`).loginAs(user)
    page.assertTextIncludes('released after your updates ended')

    const download = await client
      .get(`/licenses/${license.publicId}/download`)
      .loginAs(user)
      .redirects(0)
    download.assertHeader('location', `/licenses/${license.publicId}`)
  })

  test("another account's license downloads nothing", async ({ client }) => {
    const { user } = await createWorkspaceWithFeatures()
    const { product, license } = await activeProduct()
    await createRelease(product, { version: '1.0.0' })

    const download = await client
      .get(`/licenses/${license.publicId}/download`)
      .loginAs(user)
      .redirects(0)

    download.assertHeader('location', '/licenses')
  })
})
