import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'

import Plan from '#models/plan'
import Product from '#models/product'
import AuditLog from '#models/audit_log'
import Entitlement from '#models/entitlement'
import catalog, { CatalogError } from '#catalog/catalog_service'
import { createStaff } from '#tests/helpers'

/**
 * The catalog in the back-office (licence plan §8, M1): products, plans and
 * entitlements, and the rule that holds them together — what has shipped is
 * permanent.
 */

async function createProduct(overrides: Partial<Parameters<typeof catalog.createProduct>[0]> = {}) {
  return catalog.createProduct({
    name: 'Invoice Pro',
    slug: 'invoice-pro',
    kind: 'wordpress_plugin',
    keyPrefix: 'WIPRO',
    validationIntervalHours: 24,
    offlineGraceDays: 7,
    countDevSites: false,
    ...overrides,
  })
}

async function createPlan(
  product: Product,
  overrides: Partial<Parameters<typeof catalog.createPlan>[1]> = {}
) {
  return catalog.createPlan(product, {
    name: 'Yearly',
    slug: 'invoice-pro-yearly',
    billing: 'yearly',
    priceCents: 14_900,
    currency: 'EUR',
    licenseTerm: 'subscription',
    maxActivations: 3,
    isPublic: true,
    ...overrides,
  })
}

const productForm = {
  name: 'Invoice Pro',
  slug: 'invoice-pro',
  kind: 'wordpress_plugin',
  keyPrefix: 'wipro',
  validationIntervalHours: '24',
  offlineGraceDays: '7',
}

const planForm = {
  name: 'Yearly',
  slug: 'invoice-pro-yearly',
  billing: 'yearly',
  price: '149.00',
  currency: 'eur',
  licenseTerm: 'subscription',
  maxActivations: '3',
  isPublic: '1',
}

test.group('Catalog — access', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('support can read every catalog screen', async ({ client }) => {
    const support = await createStaff({ role: 'support' })
    const product = await createProduct()
    const plan = await createPlan(product)

    for (const path of [
      '/admin/products',
      `/admin/products/${product.publicId}`,
      `/admin/products/${product.publicId}/plans/${plan.publicId}`,
    ]) {
      const response = await client.get(path).withGuard('staff').loginAs(support)
      response.assertStatus(200)
    }
  })

  /**
   * Support sees the screen without its forms rather than a 403 (plan §6):
   * "what does the Pro plan include?" is a support question.
   */
  test('support sees no forms and cannot write', async ({ client, assert }) => {
    const support = await createStaff({ role: 'support' })
    const product = await createProduct()

    const page = await client
      .get(`/admin/products/${product.publicId}`)
      .withGuard('staff')
      .loginAs(support)

    assert.notInclude(page.text(), 'Add an entitlement')
    assert.notInclude(page.text(), 'New plan')

    const response = await client
      .post(`/admin/products/${product.publicId}`)
      .withGuard('staff')
      .loginAs(support)
      .form({ ...productForm, name: 'Renamed by support' })
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)
    await product.refresh()
    assert.equal(product.name, 'Invoice Pro')
  })

  test('the new-product screen is admin only', async ({ client }) => {
    const support = await createStaff({ role: 'support' })

    const response = await client.get('/admin/products/new').withGuard('staff').loginAs(support)

    response.assertStatus(403)
  })

  test('an unknown product id sends you back to the list', async ({ client }) => {
    const admin = await createStaff()

    const response = await client
      .get('/admin/products/prd_222222222222')
      .withGuard('staff')
      .loginAs(admin)
      .redirects(0)

    response.assertStatus(302)
    response.assertHeader('location', '/admin/products')
  })
})

test.group('Catalog — products', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('an admin creates a product as a draft', async ({ client, assert }) => {
    const admin = await createStaff()

    const response = await client
      .post('/admin/products')
      .withGuard('staff')
      .loginAs(admin)
      .form({ ...productForm, countDevSites: '1' })
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)

    const product = await Product.findByOrFail('slug', 'invoice-pro')
    assert.equal(product.status, 'draft')
    assert.equal(product.keyPrefix, 'WIPRO')
    assert.isTrue(product.countDevSites)
    response.assertHeader('location', `/admin/products/${product.publicId}`)

    const entry = await AuditLog.findByOrFail('action', 'catalog.product.created')
    assert.equal(entry.subjectId, product.publicId)
  })

  test('refuses a slug another product already uses', async ({ client, assert }) => {
    const admin = await createStaff()
    await createProduct()

    const response = await client
      .post('/admin/products')
      .withGuard('staff')
      .loginAs(admin)
      .form({ ...productForm, name: 'Copy' })
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)
    response.assertFlashMessage('inputErrorsBag', {
      slug: ['Another product already uses the slug invoice-pro.'],
    })
    assert.lengthOf(await Product.all(), 1)
  })

  test('refuses a malformed slug and key prefix', async ({ client, assert }) => {
    const admin = await createStaff()

    const response = await client
      .post('/admin/products')
      .withGuard('staff')
      .loginAs(admin)
      .form({ ...productForm, slug: 'Invoice Pro!', keyPrefix: '9-X' })
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)
    assert.lengthOf(await Product.all(), 0)
  })

  /**
   * The slug is compiled into every copy of the software that calls us.
   */
  test('the slug is editable in draft and fixed afterwards', async ({ assert }) => {
    const product = await createProduct()
    const base = {
      name: product.name,
      kind: product.kind,
      keyPrefix: product.keyPrefix,
      validationIntervalHours: 24,
      offlineGraceDays: 7,
      countDevSites: false,
    }

    await catalog.updateProduct(product, { ...base, slug: 'invoice-pro-2' })
    assert.equal(product.slug, 'invoice-pro-2')

    await catalog.updateProduct(product, { ...base, slug: 'invoice-pro-2', status: 'active' })

    await assert.rejects(
      () => catalog.updateProduct(product, { ...base, slug: 'invoice-pro-3' }),
      CatalogError
    )
  })

  test('a product cannot go back to draft', async ({ assert }) => {
    const product = await createProduct()
    const base = {
      name: product.name,
      slug: product.slug,
      kind: product.kind,
      keyPrefix: product.keyPrefix,
      validationIntervalHours: 24,
      offlineGraceDays: 7,
      countDevSites: false,
    }

    await catalog.updateProduct(product, { ...base, status: 'active' })

    await assert.rejects(
      () => catalog.updateProduct(product, { ...base, status: 'draft' }),
      CatalogError
    )
  })

  test('the list shows each product with its plans on sale', async ({ client }) => {
    const admin = await createStaff()
    const product = await createProduct()
    await createPlan(product)
    const archived = await createPlan(product, { slug: 'old', name: 'Old' })
    await catalog.setPlanArchived(archived, true)

    const response = await client.get('/admin/products').withGuard('staff').loginAs(admin)

    response.assertStatus(200)
    response.assertTextIncludes('Invoice Pro')
    response.assertTextIncludes('WIPRO')
  })
})

test.group('Catalog — plans', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('an admin adds a plan, with its price in cents', async ({ client, assert }) => {
    const admin = await createStaff()
    const product = await createProduct()

    const response = await client
      .post(`/admin/products/${product.publicId}/plans`)
      .withGuard('staff')
      .loginAs(admin)
      .form({ ...planForm, price: '149.9' })
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)

    const plan = await Plan.findByOrFail('slug', 'invoice-pro-yearly')
    assert.equal(plan.priceCents, 14_990)
    assert.equal(plan.currency, 'EUR')
    assert.equal(plan.maxActivations, 3)
    assert.isTrue(plan.isPublic)
    assert.equal(plan.status, 'active')
  })

  test('refuses a billing and term that do not belong together', async ({ client, assert }) => {
    const admin = await createStaff()
    const product = await createProduct()

    const response = await client
      .post(`/admin/products/${product.publicId}/plans`)
      .withGuard('staff')
      .loginAs(admin)
      .form({ ...planForm, licenseTerm: 'perpetual' })
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)
    response.assertFlashMessage('inputErrorsBag', {
      licenseTerm: ['A monthly or yearly plan must use the subscription term.'],
    })
    assert.lengthOf(await Plan.all(), 0)
  })

  test('an empty activations field means unlimited', async ({ client, assert }) => {
    const admin = await createStaff()
    const product = await createProduct()

    await client
      .post(`/admin/products/${product.publicId}/plans`)
      .withGuard('staff')
      .loginAs(admin)
      .form({ ...planForm, maxActivations: '' })
      .withCsrfToken()
      .redirects(0)

    const plan = await Plan.findByOrFail('slug', 'invoice-pro-yearly')
    assert.isNull(plan.maxActivations)
    assert.equal(plan.activationsLabel, 'Unlimited')
  })

  /**
   * A webhook for a provider product has to resolve to exactly one plan.
   */
  test('one provider product maps to one plan', async ({ assert }) => {
    const product = await createProduct()
    await createPlan(product, { providerProductId: 'prod_1' })

    await assert.rejects(
      () => createPlan(product, { slug: 'monthly', providerProductId: 'prod_1' }),
      CatalogError
    )
  })

  test('plan slugs are unique within a product, not across products', async ({ assert }) => {
    const first = await createProduct()
    const second = await createProduct({ slug: 'booking-pro', keyPrefix: 'BOOK' })

    await createPlan(first, { slug: 'yearly' })
    await createPlan(second, { slug: 'yearly' })

    await assert.rejects(() => createPlan(first, { slug: 'yearly' }), CatalogError)
  })

  /**
   * What customers agreed to buy is fixed once the product is on sale; the
   * price is not, because licenses copy what they need when issued.
   */
  test('billing and term are fixed after draft, the price is not', async ({ assert }) => {
    const product = await createProduct()
    const plan = await createPlan(product)
    await catalog.updateProduct(product, {
      name: product.name,
      slug: product.slug,
      kind: product.kind,
      keyPrefix: product.keyPrefix,
      status: 'active',
      validationIntervalHours: 24,
      offlineGraceDays: 7,
      countDevSites: false,
    })

    const input = {
      name: plan.name,
      slug: plan.slug,
      billing: plan.billing,
      priceCents: 19_900,
      currency: 'EUR',
      licenseTerm: plan.licenseTerm,
      maxActivations: 3,
      isPublic: true,
    }

    await catalog.updatePlan(product, plan, input)
    assert.equal(plan.priceCents, 19_900)

    await assert.rejects(
      () => catalog.updatePlan(product, plan, { ...input, billing: 'monthly' }),
      CatalogError
    )
  })

  test('archiving takes a plan off sale and can be undone', async ({ client, assert }) => {
    const admin = await createStaff()
    const product = await createProduct()
    const plan = await createPlan(product)

    const archive = () =>
      client
        .post(`/admin/products/${product.publicId}/plans/${plan.publicId}/archive`)
        .withGuard('staff')
        .loginAs(admin)
        .form({})
        .withCsrfToken()
        .redirects(0)

    await archive()
    await plan.refresh()
    assert.isTrue(plan.isArchived)

    await archive()
    await plan.refresh()
    assert.isFalse(plan.isArchived)

    const entries = await AuditLog.all()
    const actions = entries.map((entry) => entry.action)
    assert.includeMembers(actions, ['catalog.plan.archived', 'catalog.plan.restored'])
  })

  /**
   * A plan id pasted under another product's URL is a miss, not a hit.
   */
  test('a plan is only reachable through its own product', async ({ client }) => {
    const admin = await createStaff()
    const product = await createProduct()
    const other = await createProduct({ slug: 'other', keyPrefix: 'OTHER' })
    const plan = await createPlan(product)

    const response = await client
      .get(`/admin/products/${other.publicId}/plans/${plan.publicId}`)
      .withGuard('staff')
      .loginAs(admin)
      .redirects(0)

    response.assertStatus(302)
    response.assertHeader('location', '/admin/products')
  })
})

test.group('Catalog — entitlements', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('an admin defines an entitlement and sets it per plan', async ({ client, assert }) => {
    const admin = await createStaff()
    const product = await createProduct()
    const plan = await createPlan(product)

    await client
      .post(`/admin/products/${product.publicId}/entitlements`)
      .withGuard('staff')
      .loginAs(admin)
      .form({ key: 'max_projects', name: 'Projects', type: 'integer', defaultValue: '3' })
      .withCsrfToken()
      .redirects(0)

    await client
      .post(`/admin/products/${product.publicId}/entitlements`)
      .withGuard('staff')
      .loginAs(admin)
      .form({ key: 'pdf_export', name: 'PDF export', type: 'boolean' })
      .withCsrfToken()
      .redirects(0)

    const definitions = await Entitlement.query().where('product_id', product.id)
    assert.lengthOf(definitions, 2)
    assert.strictEqual(definitions.find((d) => d.key === 'max_projects')!.defaultValue, 3)

    const response = await client
      .post(`/admin/products/${product.publicId}/plans/${plan.publicId}`)
      .withGuard('staff')
      .loginAs(admin)
      .form({
        ...planForm,
        entitlements: { max_projects: '25', pdf_export: '1', not_defined: '1' },
      })
      .withCsrfToken()
      .redirects(0)

    response.assertStatus(302)
    await plan.refresh()
    assert.deepEqual(plan.entitlements, { max_projects: 25, pdf_export: true })
  })

  test('an empty value means the default applies', async ({ assert }) => {
    const product = await createProduct()
    const plan = await createPlan(product)
    await catalog.createEntitlement(product, { key: 'api', name: 'API', type: 'boolean' })

    await catalog.setPlanEntitlements(product, plan, { api: '1' })
    assert.deepEqual(plan.entitlements, { api: true })

    await catalog.setPlanEntitlements(product, plan, { api: '' })
    assert.deepEqual(plan.entitlements, {})
  })

  test('refuses a value of the wrong type, keyed to its field', async ({ assert }) => {
    const product = await createProduct()
    const plan = await createPlan(product)
    await catalog.createEntitlement(product, { key: 'seats', name: 'Seats', type: 'integer' })

    try {
      await catalog.setPlanEntitlements(product, plan, { seats: 'lots' })
      assert.fail('expected a CatalogError')
    } catch (error) {
      assert.instanceOf(error, CatalogError)
      assert.deepEqual(Object.keys((error as CatalogError).errors), ['entitlements.seats'])
    }
  })

  test('refuses a duplicate key and a default of the wrong type', async ({ assert }) => {
    const product = await createProduct()
    await catalog.createEntitlement(product, { key: 'api', name: 'API', type: 'boolean' })

    await assert.rejects(
      () => catalog.createEntitlement(product, { key: 'api', name: 'Again', type: 'boolean' }),
      CatalogError
    )
    await assert.rejects(
      () =>
        catalog.createEntitlement(product, {
          key: 'seats',
          name: 'Seats',
          type: 'integer',
          defaultValue: 'five',
        }),
      CatalogError
    )
  })

  /**
   * Deleting a definition also scrubs it from every plan, so re-creating the
   * key later — perhaps with another type — cannot resurrect old values.
   */
  test('deleting a definition removes it from every plan', async ({ client, assert }) => {
    const admin = await createStaff()
    const product = await createProduct()
    const plan = await createPlan(product)
    const entitlement = await catalog.createEntitlement(product, {
      key: 'api',
      name: 'API',
      type: 'boolean',
    })
    await catalog.createEntitlement(product, { key: 'seats', name: 'Seats', type: 'integer' })
    await catalog.setPlanEntitlements(product, plan, { api: '1', seats: '5' })

    await client
      .post(`/admin/products/${product.publicId}/entitlements/${entitlement.publicId}/delete`)
      .withGuard('staff')
      .loginAs(admin)
      .form({})
      .withCsrfToken()
      .redirects(0)

    await plan.refresh()
    assert.deepEqual(plan.entitlements, { seats: 5 })
    assert.isNull(await Entitlement.find(entitlement.id))
  })

  test('the product and plan screens render entitlements', async ({ client }) => {
    const admin = await createStaff()
    const product = await createProduct()
    const plan = await createPlan(product)
    await catalog.createEntitlement(product, {
      key: 'pdf_export',
      name: 'PDF export',
      type: 'boolean',
    })
    await catalog.createEntitlement(product, {
      key: 'seats',
      name: 'Seats',
      type: 'integer',
      defaultValue: '2',
    })
    await catalog.setPlanEntitlements(product, plan, { pdf_export: '1' })

    const show = await client
      .get(`/admin/products/${product.publicId}`)
      .withGuard('staff')
      .loginAs(admin)
    show.assertStatus(200)
    show.assertTextIncludes('pdf_export')

    const edit = await client
      .get(`/admin/products/${product.publicId}/plans/${plan.publicId}`)
      .withGuard('staff')
      .loginAs(admin)
    edit.assertStatus(200)
    edit.assertTextIncludes('entitlements[seats]')
  })
})
