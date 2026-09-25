import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'

import env from '#start/env'
import signer from '#licensing/signer'
import catalog from '#catalog/catalog_service'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'
import { createLicense } from '#tests/helpers'
import { createLicenseClient, memoryStorage } from '../../../sdk/js/src/index.js'

/**
 * The contract test (licence plan §7, M6): the real JS SDK against the real
 * server, over HTTP. The SDK's own suite proves its logic against a fake; this
 * proves the fake and the server agree — field names, reason codes, the
 * signed envelope and what it echoes. If the API drifts, this fails before a
 * customer's plugin does.
 */
test.group('JS SDK — against the server', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  const baseUrl = `http://${env.get('HOST')}:${env.get('PORT')}/api/v1`

  async function sdkFor(productSlug: string) {
    /**
     * Pinned from the server itself here; a real build pins it at build time.
     */
    const [{ kid, public_key: publicKey }] = signer.publishedKeys()

    return createLicenseClient({
      baseUrl,
      product: productSlug,
      publicKey: { [kid]: publicKey },
      storage: memoryStorage(),
      clientVersion: '1.0.0-contract',
    })
  }

  test('activates, validates, and reads entitlements', async ({ assert }) => {
    const { key, product, plan } = await createLicense()
    await catalog.createEntitlement(product, { key: 'pdf_export', name: 'PDF', type: 'boolean' })
    await catalog.setPlanEntitlements(product, plan, { pdf_export: '1' })

    const sdk = await sdkFor(product.slug)

    const activated = await sdk.activate(key, { siteUrl: 'https://shop.example.com' })
    assert.isTrue(activated.valid)
    assert.equal(activated.activation?.hostname, 'shop.example.com')
    assert.isTrue(sdk.has('pdf_export'))

    const validated = await sdk.validate({ force: true })
    assert.isTrue(validated.valid)
    assert.equal(validated.source, 'network')
    assert.equal(validated.license?.product, product.slug)
    assert.equal(validated.policy.offline_grace_days, 7)
  })

  test('hears a revocation as the reason code the server sends', async ({ assert }) => {
    const { key, product, license } = await createLicense()
    const sdk = await sdkFor(product.slug)
    await sdk.activate(key)

    await licenses.revoke(license, 'refunded', SYSTEM_ACTOR)

    const state = await sdk.validate({ force: true })
    assert.isFalse(state.valid)
    assert.equal(state.reason, 'license_revoked')
    assert.deepEqual(state.entitlements, {})
  })

  test('reports the activation limit as a state, and deactivating frees the slot', async ({
    assert,
  }) => {
    const { key, product } = await createLicense({ plan: { maxActivations: 1 } })

    const first = await sdkFor(product.slug)
    const second = await sdkFor(product.slug)

    const activated = await first.activate(key)
    assert.isTrue(activated.valid)

    const refused = await second.activate(key)
    assert.isFalse(refused.valid)
    assert.equal(refused.reason, 'activation_limit_reached')

    assert.deepEqual(await first.deactivate(), { deactivated: true })

    const retried = await second.activate(key)
    assert.isTrue(retried.valid)
  })

  test('a wrong key and a wrong product are reason codes too', async ({ assert }) => {
    const { key } = await createLicense()
    const { product: other } = await createLicense()

    const sdk = await sdkFor(other.slug)

    const wrongKey = await sdk.activate('WIPRO-AAAAA-AAAAA-AAAAA-AAAAA')
    assert.equal(wrongKey.reason, 'invalid_license')

    const wrongProduct = await sdk.activate(key)
    assert.equal(wrongProduct.reason, 'product_mismatch')
  })

  /**
   * The key the SDK is built with must match what the server signs with —
   * the one thing a real integration gets wrong most easily.
   */
  test('a client pinned to the wrong key believes nothing', async ({ assert }) => {
    const { key, product } = await createLicense()
    const { generateKeyPairSync } = await import('node:crypto')
    const wrong = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!

    const sdk = createLicenseClient({
      baseUrl,
      product: product.slug,
      publicKey: wrong,
      storage: memoryStorage(),
    })

    await assert.rejects(() => sdk.activate(key), /not with a signature this build trusts/)

    const state = await sdk.validate({ force: true })
    assert.isFalse(state.valid)
  })
})
