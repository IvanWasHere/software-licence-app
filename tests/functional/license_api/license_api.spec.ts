import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import testUtils from '@adonisjs/core/services/test_utils'

import signer from '#licensing/signer'
import catalog from '#catalog/catalog_service'
import LicenseEvent from '#models/license_event'
import activations from '#licensing/activation_service'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'
import { createCatalogPlan, createLicense } from '#tests/helpers'

/**
 * The public license API (licence plan §6): what customers' software calls.
 *
 * The contract being pinned here, beyond each endpoint's behaviour:
 * - an invalid license is `200` with `valid: false` and a reason, never a 4xx;
 * - every answer carries a signed copy of itself that verifies;
 * - no API key and no session is involved.
 */

async function licensed(options: Parameters<typeof createLicense>[0] = {}) {
  const created = await createLicense(options)
  await catalog.createEntitlement(created.product, {
    key: 'pdf_export',
    name: 'PDF export',
    type: 'boolean',
  })
  await catalog.setPlanEntitlements(created.product, created.plan, { pdf_export: '1' })

  return created
}

test.group('License API — validate', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('a good key is valid, with its license, entitlements and policy', async ({
    client,
    assert,
  }) => {
    const { key, product, license } = await licensed()

    const response = await client
      .post('/api/v1/licenses/validate')
      .json({ product: product.slug, license_key: key })

    response.assertStatus(200)
    response.assertBodyContains({
      valid: true,
      reason: null,
      license: {
        id: license.publicId,
        status: 'active',
        type: 'perpetual',
        expires_at: null,
        product: product.slug,
        key_suffix: license.keySuffix,
        activations: { used: 0, max: 3 },
      },
      entitlements: { pdf_export: true },
      policy: { validation_interval_hours: 24, offline_grace_days: 7 },
      product: product.slug,
    })

    /**
     * Nothing internal leaves: no integer ids, no key material beyond the
     * suffix the customer can already see.
     */
    const text = JSON.stringify(response.body())
    assert.notInclude(text, key)
    assert.notInclude(text, license.keyHash)
    assert.notProperty(response.body().license, 'organization_id')
  })

  test('every answer carries a signature over itself', async ({ client, assert }) => {
    const { key, product } = await licensed()

    const response = await client
      .post('/api/v1/licenses/validate')
      .json({ product: product.slug, license_key: key, nonce: 'n0nce-12345' })

    const { signed, ...plain } = response.body()
    const verified = signer.verify(signed) as Record<string, unknown>

    assert.isNotNull(verified)
    assert.deepEqual(verified, plain)
    assert.equal(verified.nonce, 'n0nce-12345')
  })

  /**
   * A business answer, not an error: SDKs branch on `reason`.
   */
  test('an unknown key is 200 with invalid_license', async ({ client }) => {
    const { product } = await createCatalogPlan()

    const response = await client
      .post('/api/v1/licenses/validate')
      .json({ product: product.slug, license_key: 'WIPRO-AAAAA-AAAAA-AAAAA-AAAAA' })

    response.assertStatus(200)
    response.assertBodyContains({
      valid: false,
      reason: 'invalid_license',
      license: null,
      entitlements: {},
    })
  })

  test('a malformed key is invalid_license too, not a 422', async ({ client }) => {
    const { product } = await createCatalogPlan()

    const response = await client
      .post('/api/v1/licenses/validate')
      .json({ product: product.slug, license_key: 'not a key at all' })

    response.assertStatus(200)
    response.assertBodyContains({ valid: false, reason: 'invalid_license' })
  })

  /**
   * A key for one product must not unlock another — and must not reveal the
   * other product's license either.
   */
  test('a key for another product is product_mismatch and says nothing more', async ({
    client,
  }) => {
    const { key } = await licensed()
    const { product: other } = await createCatalogPlan()

    const response = await client
      .post('/api/v1/licenses/validate')
      .json({ product: other.slug, license_key: key })

    response.assertStatus(200)
    response.assertBodyContains({ valid: false, reason: 'product_mismatch', license: null })
  })

  test('suspended, revoked and expired licenses each say why', async ({ client }) => {
    const suspended = await licensed()
    await licenses.suspend(suspended.license, 'review', SYSTEM_ACTOR)

    const revoked = await licensed()
    await licenses.revoke(revoked.license, 'refund', SYSTEM_ACTOR)

    const expired = await licensed()
    await licenses.changeExpiry(expired.license, DateTime.utc().minus({ days: 1 }), SYSTEM_ACTOR)

    for (const [{ key, product }, reason] of [
      [suspended, 'license_suspended'],
      [revoked, 'license_revoked'],
      [expired, 'license_expired'],
    ] as const) {
      const response = await client
        .post('/api/v1/licenses/validate')
        .json({ product: product.slug, license_key: key })

      response.assertBodyContains({ valid: false, reason, entitlements: {} })
    }
  })

  test('with an instance id, the instance must be activated', async ({ client }) => {
    const { key, product, license } = await licensed()

    const before = await client
      .post('/api/v1/licenses/validate')
      .json({ product: product.slug, license_key: key, instance_id: 'site-1' })
    before.assertBodyContains({ valid: false, reason: 'not_activated' })

    await activations.activate(license, { instanceId: 'site-1' }, SYSTEM_ACTOR)

    const after = await client
      .post('/api/v1/licenses/validate')
      .json({ product: product.slug, license_key: key, instance_id: 'site-1' })
    after.assertBodyContains({
      valid: true,
      instance_id: 'site-1',
      activation: { instance_id: 'site-1' },
    })
  })

  test('refuses a request missing its fields with a 422', async ({ client }) => {
    const response = await client.post('/api/v1/licenses/validate').json({ license_key: 'x' })

    response.assertStatus(422)
    response.assertBodyContains({ error: { code: 'validation_failed' } })
  })

  /**
   * The key and product are the only credentials. A client that sends no
   * Authorization header and no cookie — every plugin in the wild — gets a
   * full answer.
   */
  test('needs no API key and no session', async ({ client }) => {
    const { key, product } = await licensed()

    const response = await client
      .post('/api/v1/licenses/validate')
      .json({ product: product.slug, license_key: key })

    response.assertStatus(200)
    response.assertBodyContains({ valid: true })
  })
})

test.group('License API — activate and deactivate', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('activates an installation and records the client', async ({ client, assert }) => {
    const { key, product, license } = await licensed()

    const response = await client
      .post('/api/v1/licenses/activate')
      .header('user-agent', 'InvoicePro/1.4 WordPress/6.6')
      .json({
        product: product.slug,
        license_key: key,
        instance_id: 'site-1',
        site_url: 'https://www.shop.example.com',
        client_version: '1.4.0',
      })

    response.assertStatus(200)
    response.assertBodyContains({
      activated: true,
      valid: true,
      activation: { instance_id: 'site-1', hostname: 'shop.example.com', is_dev: false },
      license: { activations: { used: 1, max: 3 } },
      entitlements: { pdf_export: true },
    })

    const [activation] = await activations.live(license)
    assert.equal(activation.clientVersion, '1.4.0')
    assert.equal(activation.userAgent, 'InvoicePro/1.4 WordPress/6.6')

    const event = await LicenseEvent.query().where('type', 'activated').firstOrFail()
    assert.equal(event.actorType, 'client')
  })

  test('activating twice is one activation', async ({ client, assert }) => {
    const { key, product, license } = await licensed()
    const body = { product: product.slug, license_key: key, instance_id: 'site-1' }

    await client.post('/api/v1/licenses/activate').json(body)
    const again = await client.post('/api/v1/licenses/activate').json(body)

    again.assertBodyContains({ activated: true, license: { activations: { used: 1 } } })
    assert.lengthOf(await activations.live(license), 1)
  })

  test('the limit is a business answer with the numbers', async ({ client }) => {
    const { key, product } = await licensed({ plan: { maxActivations: 1 } })

    await client
      .post('/api/v1/licenses/activate')
      .json({ product: product.slug, license_key: key, instance_id: 'a', site_url: 'a.com' })
    const refused = await client
      .post('/api/v1/licenses/activate')
      .json({ product: product.slug, license_key: key, instance_id: 'b', site_url: 'b.com' })

    refused.assertStatus(200)
    refused.assertBodyContains({
      activated: false,
      valid: false,
      reason: 'activation_limit_reached',
      license: { activations: { used: 1, max: 1 } },
    })
  })

  test('an invalid license activates nothing', async ({ client, assert }) => {
    const { key, product, license } = await licensed()
    await licenses.revoke(license, 'refund', SYSTEM_ACTOR)

    const response = await client
      .post('/api/v1/licenses/activate')
      .json({ product: product.slug, license_key: key, instance_id: 'a' })

    response.assertBodyContains({ activated: false, reason: 'license_revoked' })
    assert.lengthOf(await activations.live(license), 0)
  })

  test('activation requires an instance id', async ({ client }) => {
    const { key, product } = await licensed()

    const response = await client
      .post('/api/v1/licenses/activate')
      .json({ product: product.slug, license_key: key })

    response.assertStatus(422)
  })

  test('deactivating frees the slot, and twice is not an error', async ({ client, assert }) => {
    const { key, product, license } = await licensed({ plan: { maxActivations: 1 } })
    const body = { product: product.slug, license_key: key, instance_id: 'a' }

    await client.post('/api/v1/licenses/activate').json(body)

    const first = await client.post('/api/v1/licenses/deactivate').json(body)
    first.assertBodyContains({ deactivated: true, license: { activations: { used: 0 } } })

    const second = await client.post('/api/v1/licenses/deactivate').json(body)
    second.assertStatus(200)
    second.assertBodyContains({ deactivated: false, reason: null })

    assert.lengthOf(await activations.live(license), 0)
  })

  /**
   * An expired customer must still be able to free a slot — tidying up is
   * not something a lapsed payment should block.
   */
  test('an expired license can still deactivate', async ({ client, assert }) => {
    const { key, product, license } = await licensed()
    await activations.activate(license, { instanceId: 'a' }, SYSTEM_ACTOR)
    await licenses.changeExpiry(license, DateTime.utc().minus({ days: 1 }), SYSTEM_ACTOR)

    const response = await client
      .post('/api/v1/licenses/deactivate')
      .json({ product: product.slug, license_key: key, instance_id: 'a' })

    response.assertBodyContains({ deactivated: true })
    assert.lengthOf(await activations.live(license), 0)
  })

  test('deactivating with the wrong key or product does nothing', async ({ client, assert }) => {
    const { key, product, license } = await licensed()
    const { product: other } = await createCatalogPlan()
    await activations.activate(license, { instanceId: 'a' }, SYSTEM_ACTOR)

    const wrongProduct = await client
      .post('/api/v1/licenses/deactivate')
      .json({ product: other.slug, license_key: key, instance_id: 'a' })
    wrongProduct.assertBodyContains({ deactivated: false, reason: 'product_mismatch' })

    const wrongKey = await client.post('/api/v1/licenses/deactivate').json({
      product: product.slug,
      license_key: 'WIPRO-AAAAA-AAAAA-AAAAA-AAAAA',
      instance_id: 'a',
    })
    wrongKey.assertBodyContains({ deactivated: false, reason: 'invalid_license' })

    assert.lengthOf(await activations.live(license), 1)
  })
})

test.group('License API — products and keys', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('describes an active product and its public plans', async ({ client }) => {
    const { product } = await createCatalogPlan({ plan: { slug: 'lifetime', name: 'Lifetime' } })
    await catalog.createPlan(product, {
      name: 'Secret',
      slug: 'secret',
      billing: 'one_time',
      priceCents: 0,
      currency: 'EUR',
      licenseTerm: 'perpetual',
      isPublic: false,
    })
    product.status = 'active'
    await product.save()

    const response = await client.get(`/api/v1/products/${product.slug}`)

    response.assertStatus(200)
    response.assertBody({
      data: {
        slug: product.slug,
        name: product.name,
        kind: 'wordpress_plugin',
        status: 'active',
        description: null,
        homepage_url: null,
        docs_url: null,
        policy: { validation_interval_hours: 24, offline_grace_days: 7 },
        plans: [
          {
            slug: 'lifetime',
            name: 'Lifetime',
            billing: 'one_time',
            price_cents: 39_900,
            currency: 'EUR',
            license_term: 'perpetual',
            term_days: null,
            updates_days: null,
            max_activations: 3,
          },
        ],
      },
    })
  })

  test('a draft product does not exist to the outside', async ({ client }) => {
    const { product } = await createCatalogPlan()

    const response = await client.get(`/api/v1/products/${product.slug}`)

    response.assertStatus(404)
    response.assertBodyContains({ error: { code: 'not_found' } })
  })

  test('publishes the signing key', async ({ client, assert }) => {
    const response = await client.get('/api/v1/keys')

    response.assertStatus(200)
    const [key] = response.body().data
    assert.equal(key.kid, signer.keyId)
    assert.equal(key.alg, 'Ed25519')
    assert.equal(Buffer.from(key.public_key, 'base64url').length, 32)
  })
})

test.group('License API — transport', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  /**
   * The JS SDK calls from customers' own domains.
   */
  test('answers a browser preflight from any origin', async ({ client }) => {
    const response = await client
      .options('/api/v1/licenses/validate')
      .header('origin', 'https://customer-site.example')
      .header('access-control-request-method', 'POST')

    response.assertStatus(204)
    response.assertHeader('access-control-allow-origin', '*')
    response.assertHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  })

  test('every response has CORS, a request id and no-store', async ({ client, assert }) => {
    const { product } = await createCatalogPlan()

    const ok = await client
      .post('/api/v1/licenses/validate')
      .header('x-request-id', 'sdk-req-1')
      .json({ product: product.slug, license_key: 'x' })
    const invalid = await client.post('/api/v1/licenses/validate').json({})

    for (const response of [ok, invalid]) {
      response.assertHeader('access-control-allow-origin', '*')
      response.assertHeader('cache-control', 'no-store')
      assert.exists(response.header('x-request-id'))
    }

    ok.assertHeader('x-request-id', 'sdk-req-1')
    ok.assertBodyContains({ request_id: 'sdk-req-1' })
    assert.notExists(ok.header('access-control-allow-credentials'))
  })

  /**
   * One key hammered from anywhere is slowed down on its own, as the API's
   * error shape rather than the limiter's plain text.
   */
  test('rate limits one key at 30 a minute', async ({ client }) => {
    const { key, product } = await licensed()
    const body = { product: product.slug, license_key: key }

    for (let i = 0; i < 30; i++) {
      const response = await client.post('/api/v1/licenses/validate').json(body)
      response.assertStatus(200)
    }

    const limited = await client.post('/api/v1/licenses/validate').json(body)

    limited.assertStatus(429)
    limited.assertBodyContains({ error: { code: 'rate_limit_exceeded' } })
    limited.assertHeader('access-control-allow-origin', '*')

    /**
     * Another key from the same address is unaffected.
     */
    const other = await licensed()
    const fine = await client
      .post('/api/v1/licenses/validate')
      .json({ product: other.product.slug, license_key: other.key })
    fine.assertStatus(200)
  })

  test('the organisation API still requires its key', async ({ client }) => {
    const response = await client.get('/api/v1/organization')

    response.assertStatus(401)
  })
})
