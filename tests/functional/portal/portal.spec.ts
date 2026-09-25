import { test } from '@japa/runner'
import mail from '@adonisjs/mail/services/main'
import testUtils from '@adonisjs/core/services/test_utils'

import Order from '#models/order'
import License from '#models/license'
import LicenseEvent from '#models/license_event'
import activations from '#licensing/activation_service'
import { SYSTEM_ACTOR } from '#licensing/license_service'
import {
  addMember,
  createLicense,
  createSellablePlan,
  createWorkspace,
  creemLicensing,
  restorePaymentProvider,
  runQueue,
  signedWebhook,
  useFakePaymentProvider,
  type FakePaymentProvider,
} from '#tests/helpers'

/**
 * The customer side (licence plan §6, M5): licenses in the account, and the
 * public pricing page that sells them.
 */
test.group('Portal — licenses', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('lists the account’s licenses and nobody else’s', async ({ client, assert }) => {
    const { user, organization } = await createWorkspace()
    const { license } = await createLicense({ organization })
    const other = await createLicense()

    const response = await client.get('/licenses').loginAs(user)

    response.assertStatus(200)
    assert.include(response.text(), license.publicId)
    assert.notInclude(response.text(), other.license.publicId)
  })

  /**
   * Whoever installs the software needs the key, and on an agency account
   * that is rarely the person who paid.
   */
  test('a member can see and reveal a key', async ({ client, assert }) => {
    const { user: owner, organization } = await createWorkspace()
    const member = await addMember(organization, owner, 'dev@example.com')
    const { license, key } = await createLicense({ organization })

    const page = await client.get(`/licenses/${license.publicId}`).loginAs(member)
    page.assertStatus(200)
    assert.notInclude(page.text(), key)

    const reveal = await client
      .post(`/licenses/${license.publicId}/reveal`)
      .loginAs(member)
      .withCsrfToken()
      .redirects(0)

    reveal.assertFlashMessage('revealedKey', key)

    const event = await LicenseEvent.query().where('type', 'key_revealed').firstOrFail()
    assert.equal(event.actorType, 'user')
    assert.equal(event.actorId, member.id)
  })

  test('frees a slot', async ({ client, assert }) => {
    const { user, organization } = await createWorkspace()
    const { license } = await createLicense({ organization })
    const result = await activations.activate(
      license,
      { instanceId: 'site-1', siteUrl: 'https://old.example.com' },
      SYSTEM_ACTOR
    )

    const page = await client.get(`/licenses/${license.publicId}`).loginAs(user)
    page.assertTextIncludes('old.example.com')

    await client
      .post(
        `/licenses/${license.publicId}/activations/${result.ok && result.activation.publicId}/deactivate`
      )
      .loginAs(user)
      .withCsrfToken()
      .redirects(0)

    assert.lengthOf(await activations.live(license), 0)
  })

  /**
   * Another account's ids behave exactly like ids that do not exist — for
   * reading, revealing and deactivating alike.
   */
  test('another account’s license is out of reach', async ({ client, assert }) => {
    const { user } = await createWorkspace()
    const { license, key } = await createLicense()
    const result = await activations.activate(license, { instanceId: 'a' }, SYSTEM_ACTOR)
    const activationId = result.ok ? result.activation.publicId : ''

    const show = await client.get(`/licenses/${license.publicId}`).loginAs(user).redirects(0)
    show.assertStatus(302)
    show.assertHeader('location', '/licenses')

    const reveal = await client
      .post(`/licenses/${license.publicId}/reveal`)
      .loginAs(user)
      .withCsrfToken()
      .redirects(0)
    assert.notEqual(reveal.flashMessages()?.revealedKey, key)

    await client
      .post(`/licenses/${license.publicId}/activations/${activationId}/deactivate`)
      .loginAs(user)
      .withCsrfToken()
      .redirects(0)

    assert.lengthOf(await activations.live(license), 1)
    assert.lengthOf(await LicenseEvent.query().where('type', 'key_revealed'), 0)
  })

  test('needs a signed-in account', async ({ client }) => {
    const response = await client.get('/licenses').redirects(0)

    response.assertStatus(302)
    response.assertHeader('location', '/login')
  })
})

test.group('Portal — the pricing page', (group) => {
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

  test('shows a product’s plans on sale, and only those', async ({ client, assert }) => {
    const { product, plan } = await createSellablePlan({ name: 'Lifetime', slug: 'lifetime' })
    const { default: catalog } = await import('#catalog/catalog_service')
    await catalog.createPlan(product, {
      name: 'Hidden deal',
      slug: 'hidden',
      billing: 'one_time',
      priceCents: 100,
      currency: 'EUR',
      licenseTerm: 'perpetual',
      isPublic: false,
      providerProductId: 'prod_hidden',
    })

    const response = await client.get(`/pricing/${product.slug}`)

    response.assertStatus(200)
    assert.include(response.text(), plan.name)
    assert.notInclude(response.text(), 'Hidden deal')
  })

  test('a draft product has no pricing page', async ({ client }) => {
    const { product } = await createSellablePlan()
    product.status = 'draft'
    await product.save()

    const response = await client.get(`/pricing/${product.slug}`)

    response.assertStatus(404)
  })

  test('an anonymous buyer gives an email and is sent to the provider', async ({
    client,
    assert,
  }) => {
    const { product, plan } = await createSellablePlan({ slug: 'lifetime' })

    const response = await client
      .post(`/pricing/${product.slug}/lifetime`)
      .form({ email: 'Anon@Example.com' })
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)
    response.assertHeader('location', `https://checkout.test/${plan.providerProductId}`)

    const order = await Order.firstOrFail()
    assert.equal(order.email, 'anon@example.com')
    assert.isNull(order.organizationId)
    assert.include(provider.checkouts[0].successUrl, `/checkout/return?order=${order.publicId}`)
  })

  test('without an email, an anonymous buyer is sent back', async ({ client, assert }) => {
    const { product } = await createSellablePlan({ slug: 'lifetime' })

    const response = await client
      .post(`/pricing/${product.slug}/lifetime`)
      .form({})
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)
    assert.lengthOf(await Order.all(), 0)
  })

  test('a signed-in buyer’s order goes to their account', async ({ client, assert }) => {
    const { user, organization } = await createWorkspace({ email: 'me@example.com' })
    const { product } = await createSellablePlan({ slug: 'lifetime' })

    await client
      .post(`/pricing/${product.slug}/lifetime`)
      .loginAs(user)
      .form({ email: 'someone-else@example.com' })
      .withCsrfToken()
      .redirects(0)

    const order = await Order.firstOrFail()
    assert.equal(order.email, 'me@example.com')
    assert.equal(order.organizationId, organization.id)
  })

  /**
   * The return page grants nothing; it reports what the webhook did.
   */
  test('the return page waits for the webhook, then says the key is sent', async ({
    client,
    assert,
  }) => {
    const { product } = await createSellablePlan({ slug: 'lifetime' })

    await client
      .post(`/pricing/${product.slug}/lifetime`)
      .form({ email: 'buyer@example.com' })
      .withCsrfToken()
      .redirects(0)

    const order = await Order.firstOrFail()

    const waiting = await client.get(`/checkout/status/${order.publicId}`)
    waiting.assertBody({ status: 'pending', fulfilled: false })

    const body = creemLicensing.oneTimeCheckout({ orderPublicId: order.publicId })
    const { headers } = signedWebhook(body)
    await client.post('/webhooks/creem').headers(headers).json(body)
    await runQueue('default')

    const done = await client.get(`/checkout/status/${order.publicId}`)
    done.assertBody({ status: 'paid', fulfilled: true })

    const page = await client.get(`/checkout/return?order=${order.publicId}`)
    page.assertStatus(200)

    const license = await License.firstOrFail()
    assert.notInclude(page.text(), license.keyEncrypted)
    assert.notInclude(JSON.stringify(done.body()), license.keyEncrypted)
  })
})
