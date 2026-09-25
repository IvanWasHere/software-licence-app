import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import mail from '@adonisjs/mail/services/main'

import File from '#models/file'
import User from '#models/user'
import Order from '#models/order'
import ApiKey from '#models/api_key'
import License from '#models/license'
import orders from '#commerce/order_service'
import activations from '#licensing/activation_service'
import { SYSTEM_ACTOR } from '#licensing/license_service'
import {
  clearStorage,
  createSellablePlan,
  createWorkspaceWithFeatures,
  restorePaymentProvider,
  useFakePaymentProvider,
  TEST_PASSWORD,
} from '#tests/helpers'

/**
 * The flows in the application that a functional test cannot fully stand in
 * for (plan §15): one leaves for a payment provider, one carries a real file
 * through a real `multipart/form-data` submission, and one is only reachable
 * through a <dialog> that a browser has to open.
 */
test.group('Buying a license', (group) => {
  group.each.setup(() => {
    const fake = useFakePaymentProvider()

    return () => {
      restorePaymentProvider()
      void fake
    }
  })

  /**
   * The whole of licence plan M5's promise, in a real browser: a guest buys
   * from the pricing page, the payment lands, and the key is waiting in an
   * account they can sign in to — where they can free a slot.
   */
  test('a guest buys, the payment lands, and the key is in their account', async ({
    visit,
    assert,
  }) => {
    const { product, plan } = await createSellablePlan({ name: 'Lifetime', slug: 'lifetime' })

    const page = await visit(`/pricing/${product.slug}`)
    await page.fill('input[name="email"]', 'buyer@example.com')

    /**
     * The request the browser issues is the assertion, not the page it lands
     * on. The fake provider's checkout host does not exist — nothing should
     * leave the machine to prove a handoff — and a form POST answering with
     * an off-site redirect is subject to `form-action`, enforced across the
     * redirect and failing silently (config/shield.ts). Blocked, the browser
     * issues no request at all and this times out.
     */
    const [request] = await Promise.all([
      page.waitForRequest('https://checkout.test/**'),
      page.click('button:has-text("Buy Lifetime")'),
    ])
    assert.include(request.url(), plan.providerProductId!)

    const order = await Order.firstOrFail()

    /**
     * Back from checkout, before the webhook: nothing granted, and the page
     * says it is waiting. Rendered by Alpine from an `x-if` template, so this
     * also proves the bundle ran.
     */
    await page.goto(`/checkout/return?order=${order.publicId}`)
    await page.assertTextContains('body', 'Confirming your payment')

    /**
     * The payment lands — `fulfil` is what the webhook calls, and the webhook
     * itself is the functional suite's to prove.
     */
    await orders.fulfil(order)
    await page.waitForSelector('text=your key is on its way', { timeout: 10_000 })

    /**
     * The account was made without a password; set one the way the reset
     * link in the key email would.
     */
    const buyer = await User.findByOrFail('email', 'buyer@example.com')
    buyer.password = TEST_PASSWORD
    buyer.emailVerifiedAt = DateTime.utc()
    await buyer.save()

    const license = await License.firstOrFail()
    await activations.activate(
      license,
      { instanceId: 'site-1', siteUrl: 'https://old-shop.example' },
      SYSTEM_ACTOR
    )

    await page.goto('/login')
    await page.fill('input[name="email"]', 'buyer@example.com')
    await page.fill('input[name="password"]', TEST_PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForURL('**/dashboard')

    await page.goto(`/licenses/${license.publicId}`)
    await page.click('button:has-text("Show key")')
    await page.assertTextContains('body', license.keyEncrypted)

    await page.assertTextContains('body', 'old-shop.example')
    await page.click('button:has-text("Deactivate")')
    await page.assertTextContains('body', 'Its slot is free')

    assert.lengthOf(await activations.live(license), 0)
  })
})

test.group('Uploading a file', (group) => {
  group.each.setup(() => {
    mail.fake()

    return async () => {
      mail.restore()
      await clearStorage()
    }
  })

  test('uploads a file and lists it', async ({ visit, assert }) => {
    await createWorkspaceWithFeatures({ email: 'jane@example.com' })

    const page = await visit('/login')
    await page.fill('input[name="email"]', 'jane@example.com')
    await page.fill('input[name="password"]', TEST_PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForURL('**/dashboard')

    await page.goto('/files')

    /**
     * The input is visually hidden behind the drop zone — the drop zone is
     * Alpine sugar over a plain file input, which is the point of building
     * it that way (plan §13.3), and it is the input a browser actually
     * submits.
     */
    await page.setInputFiles('input[type="file"]', {
      name: 'quarterly-report.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('the numbers went up'),
    })

    await page.click('button[type="submit"]:has-text("Upload")')

    await page.waitForURL('**/files')
    await page.assertTextContains('body', 'quarterly-report.txt')

    /**
     * And it is a row, not just a toast: the file is recorded against the
     * organisation with the name the person recognises.
     */
    const stored = await File.query().firstOrFail()
    assert.equal(stored.originalName, 'quarterly-report.txt')
  })

  test('refuses a file type that is not allowed', async ({ visit }) => {
    await createWorkspaceWithFeatures({ email: 'jane@example.com' })

    const page = await visit('/login')
    await page.fill('input[name="email"]', 'jane@example.com')
    await page.fill('input[name="password"]', TEST_PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForURL('**/dashboard')

    await page.goto('/files')

    await page.setInputFiles('input[type="file"]', {
      name: 'payload.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<script>alert(1)</script>'),
    })

    await page.click('button[type="submit"]:has-text("Upload")')

    await page.waitForURL('**/files')
    await page.assertTextContains('body', 'That kind of file is not accepted')
  })
})

/*
| Creating an API key happens inside a modal, and the two controls that open and
| close it are the only part of the flow a functional test never touches: it
| POSTs to `lists.store` directly and passes whether or not anything on the
| page can reach that form.
|
| Both had been broken that way. The button opened the dialog from an inline
| `onclick`, which the Content-Security-Policy refuses to run, and the close
| button called `$el.close()` where `$el` was the button rather than the
| <dialog>.
*/
test.group('Creating an API key', () => {
  test('opens the modal, creates the key, and closes on Cancel', async ({ visit, assert }) => {
    const { organization } = await createWorkspaceWithFeatures({ email: 'jane@example.com' })

    const page = await visit('/login')
    await page.fill('input[name="email"]', 'jane@example.com')
    await page.fill('input[name="password"]', TEST_PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForURL('**/dashboard')

    await page.goto('/settings/api-keys')

    /**
     * The dialog is in the DOM from the start and inert until something calls
     * `showModal()` on it, so "is it open" is the assertion that matters.
     */
    await page.click('button:has-text("New key")')
    await page.waitForSelector('#new-api-key[open]')

    await page.fill('#new-api-key input[name="name"]', 'Nightly sync')
    await page.click('#new-api-key-form input[value="licenses:read"]')
    await page.click('button:has-text("Create key")')

    await page.assertTextContains('body', 'Nightly sync')

    const key = await ApiKey.query().where('organization_id', organization.id).firstOrFail()
    assert.equal(key.name, 'Nightly sync')

    await page.goto('/settings/api-keys')
    await page.click('button:has-text("New key")')
    await page.waitForSelector('#new-api-key[open]')
    await page.click('#new-api-key button:has-text("Cancel")')

    /* A <dialog> that is not open is not rendered, so "hidden" is "closed". */
    await page.waitForSelector('#new-api-key', { state: 'hidden' })
  })
})
