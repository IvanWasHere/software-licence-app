import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'

import { decodeCursor } from '#api/cursor'
import { addMember, createApiWorkspace, createLicense } from '#tests/helpers'

/**
 * The organisation API's endpoints (plan §11, §15), with a customer's
 * licenses as the resource they act on since the starter's lists demo went
 * (licence plan M5).
 */
test.group('API — licenses', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('returns public ids and never internal ones', async ({ client, assert }) => {
    const { organization, headers } = await createApiWorkspace()
    const { license, key } = await createLicense({ organization })

    const response = await client.get('/api/v1/licenses').headers(headers)

    response.assertStatus(200)

    const [row] = response.body().data
    assert.equal(row.id, license.publicId)
    assert.match(row.id, /^lic_/)

    /**
     * The transformer's whole job: adding a column to the model must not
     * widen the public contract, an integer id must never leave, and neither
     * may the key.
     */
    assert.notProperty(row, 'organization_id')
    assert.notProperty(row, 'key_hash')
    assert.notProperty(row, 'key_encrypted')
    assert.notInclude(JSON.stringify(row), key)
    assert.notInclude(JSON.stringify(row), `"${license.id}"`)
  })

  test('reads one license', async ({ client }) => {
    const { organization, headers } = await createApiWorkspace()
    const { license, product } = await createLicense({ organization })

    const response = await client.get(`/api/v1/licenses/${license.publicId}`).headers(headers)

    response.assertStatus(200)
    response.assertBodyContains({
      data: { id: license.publicId, product: product.slug, status: 'active', expires_at: null },
    })
  })

  test('every timestamp is emitted in one format', async ({ client, assert }) => {
    const { organization, headers } = await createApiWorkspace()
    await createLicense({ organization })

    const response = await client.get('/api/v1/licenses').headers(headers)
    const [row] = response.body().data

    assert.match(row.created_at, /Z$/, 'UTC with a Z, never +00:00')
  })

  test('an unknown id is a 404 with a stable code', async ({ client }) => {
    const { headers } = await createApiWorkspace()

    const response = await client.get('/api/v1/licenses/lic_zzzzzzzzzzzz').headers(headers)

    response.assertStatus(404)
    response.assertBodyContains({ error: { code: 'not_found' } })
  })
})

test.group('API — pagination', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  async function licensesFor(
    organization: NonNullable<Parameters<typeof createLicense>[0]>['organization'],
    count: number
  ) {
    for (let index = 0; index < count; index++) {
      await createLicense({ organization })
    }
  }

  test('walks every row exactly once across pages', async ({ client, assert }) => {
    const { organization, headers } = await createApiWorkspace()
    await licensesFor(organization, 7)

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0

    do {
      const url: string = `/api/v1/licenses?limit=3${cursor ? `&cursor=${cursor}` : ''}`
      const response = await client.get(url).headers(headers)

      response.assertStatus(200)

      for (const row of response.body().data) {
        seen.push(row.id)
      }

      cursor = response.body().meta.next_cursor
      pages++
    } while (cursor && pages < 10)

    assert.lengthOf(seen, 7)
    assert.lengthOf(new Set(seen), 7, 'no duplicates')
    assert.isNull(cursor, 'and it terminated on its own')
  })

  /**
   * The reason for cursors: under offset pagination an insert between page
   * fetches shifts every row down, so a syncing client sees one twice and
   * misses another (plan §11).
   */
  test('a row inserted mid-walk cannot make the client skip or repeat one', async ({
    client,
    assert,
  }) => {
    const { organization, headers } = await createApiWorkspace()
    await licensesFor(organization, 4)

    const first = await client.get('/api/v1/licenses?limit=2').headers(headers)
    const firstIds = first.body().data.map((row: { id: string }) => row.id)

    await createLicense({ organization })

    const second = await client
      .get(`/api/v1/licenses?limit=2&cursor=${first.body().meta.next_cursor}`)
      .headers(headers)
    const secondIds = second.body().data.map((row: { id: string }) => row.id)

    assert.isEmpty(
      firstIds.filter((id: string) => secondIds.includes(id)),
      'no row appears on both pages'
    )
  })

  test('the page size is clamped rather than refused', async ({ client, assert }) => {
    const { headers } = await createApiWorkspace()

    const response = await client.get('/api/v1/licenses?limit=100000').headers(headers)

    response.assertStatus(200)
    assert.equal(response.body().meta.limit, 100)
  })

  test('a nonsense cursor starts from the beginning instead of erroring', async ({
    client,
    assert,
  }) => {
    const { organization, headers } = await createApiWorkspace()
    await createLicense({ organization })

    const response = await client.get('/api/v1/licenses?cursor=%%%broken%%%').headers(headers)

    response.assertStatus(200)
    assert.lengthOf(response.body().data, 1)
  })

  test('the cursor is opaque', async ({ client, assert }) => {
    const { organization, headers } = await createApiWorkspace()
    await licensesFor(organization, 2)

    const response = await client.get('/api/v1/licenses?limit=1').headers(headers)
    const cursor = response.body().meta.next_cursor

    assert.isString(cursor)
    assert.isNumber(decodeCursor(cursor), 'ours to decode')
    assert.notMatch(cursor, /^\d+$/, 'not a bare id')
  })
})

test.group('API — account usage', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  /**
   * The usage payload is built from the quota registry (`start/quotas.ts`)
   * rather than written out, so this pins the published shape: a quota that
   * is renamed, added or dropped changes a documented API, and it should
   * break a test here rather than a customer's integration.
   */
  test('GET /organization reports every registered quota, and nothing else', async ({
    client,
    assert,
  }) => {
    const { headers } = await createApiWorkspace()

    const response = await client.get('/api/v1/organization').headers(headers)

    response.assertStatus(200)

    const usage = response.body().data.usage

    assert.deepEqual(Object.keys(usage).sort(), ['seats', 'storage_mb'])

    for (const [key, quota] of Object.entries(usage)) {
      assert.deepEqual(Object.keys(quota as object).sort(), ['limit', 'remaining', 'used'], key)
    }
  })

  test('unlimited is reported as null, not as a large number', async ({ client, assert }) => {
    const { organization, headers } = await createApiWorkspace()
    organization.limitOverrides = { seats: null }
    await organization.save()

    const response = await client.get('/api/v1/organization').headers(headers)

    assert.isNull(response.body().data.usage.seats.limit)
    assert.isNull(response.body().data.usage.seats.remaining)
  })
})

test.group('API — members', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('lists members with just enough to resolve an assignee', async ({ client, assert }) => {
    const { user, organization, headers } = await createApiWorkspace()
    await addMember(organization, user, 'sam@example.com')

    const response = await client.get('/api/v1/members').headers(headers)

    response.assertStatus(200)
    assert.lengthOf(response.body().data, 2)

    const [row] = response.body().data
    assert.deepEqual(Object.keys(row).sort(), ['email', 'id', 'name', 'role'])

    /**
     * Nothing about the person beyond what an assignment needs.
     */
    assert.notProperty(row, 'two_factor_secret')
    assert.notProperty(row, 'last_login_at')
    assert.notProperty(row, 'avatar_key')
  })
})

/**
 * Not a test of the spec's prose, but of the promises it makes: if a
 * documented path or status disappears, somebody's generated client breaks.
 */
test.group('API — the published document', () => {
  test('documents every route the API actually exposes', async ({ client, assert }) => {
    const response = await client.get('/openapi.json')

    response.assertStatus(200)

    const document = response.body()
    const documented = Object.keys(document.paths)

    for (const path of ['/organization', '/members', '/licenses', '/licenses/{id}']) {
      assert.include(documented, path, path)
    }
  })

  /**
   * The license API is documented beside the organisation API, and marked
   * as needing no API key — a generated client that attached one would be
   * wrong in a way nobody notices.
   */
  test('documents the license API as keyless', async ({ client, assert }) => {
    const response = await client.get('/openapi.json')
    const document = response.body()

    for (const [path, method] of [
      ['/licenses/validate', 'post'],
      ['/licenses/activate', 'post'],
      ['/licenses/deactivate', 'post'],
      ['/products/{slug}', 'get'],
      ['/keys', 'get'],
    ]) {
      assert.property(document.paths, path, path)
      assert.deepEqual(document.paths[path][method].security, [], path)
    }

    assert.include(
      document.paths['/licenses/validate'].post.responses['200'].content['application/json'].schema
        .properties.reason.enum,
      'activation_limit_reached'
    )

    for (const path of ['/checkout', '/orders/{id}', '/customers/licenses']) {
      assert.property(document.paths, path, path)
    }
  })

  /**
   * Schemas and the usage block are assembled rather than written out —
   * features contribute schemas through the OpenAPI registry, and the
   * `/organization` usage properties are built from the quota registry so
   * that the document and `OrganizationTransformer` cannot disagree about
   * which quotas exist. Both are pinned here, because a spec that quietly
   * stops describing a payload is worse than one that never described it.
   */
  test('carries both core and feature schemas', async ({ client, assert }) => {
    const response = await client.get('/openapi.json')

    const schemas = Object.keys(response.body().components.schemas)

    assert.includeMembers(schemas, ['Error', 'Member', 'Quota'], 'core')
    assert.includeMembers(
      schemas,
      ['License', 'LicenseDecision', 'Order'],
      'contributed by features'
    )
  })

  test('documents exactly the quotas the payload reports', async ({ client, assert }) => {
    const response = await client.get('/openapi.json')

    const usage =
      response.body().paths['/organization'].get.responses['200'].content['application/json'].schema
        .properties.data.properties.usage

    assert.deepEqual(Object.keys(usage.properties).sort(), ['seats', 'storage_mb'])
  })

  test('is readable without a key, because that is when people read it', async ({ client }) => {
    const response = await client.get('/docs')

    response.assertStatus(200)
  })

  test('describes the cursor contract a sync depends on', async ({ client, assert }) => {
    const response = await client.get('/openapi.json')
    const document = response.body()

    const meta =
      document.paths['/licenses'].get.responses['200'].content['application/json'].schema.properties
        .meta

    assert.include(meta.properties.next_cursor.description, 'null on the last page')
  })
})
