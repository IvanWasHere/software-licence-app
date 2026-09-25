import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'

import dashboard from '#dashboard/widgets'
import { createLicense, createWorkspace } from '#tests/helpers'

/**
 * The Overview screen as a shell (plan §13.5).
 *
 * The dashboard names nothing it shows: the figures and panels are widgets
 * registered in `start/dashboard.ts` and rendered through a dynamic
 * `@include`, and the meters come from the quota registry. That indirection
 * is the thing under test here.
 *
 * These are deliberately **positive** assertions on rendered content. The
 * isolation suite already checks that another workspace's rows do not appear,
 * but a `notInclude` passes just as happily when a widget renders nothing at
 * all — which is exactly how a broken `@include` would fail.
 */
test.group('Dashboard', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('renders every registered widget', async ({ client, assert }) => {
    const { user, organization } = await createWorkspace()
    await createLicense({ organization })

    const response = await client.get('/dashboard').loginAs(user).withCsrfToken()

    response.assertStatus(200)

    /**
     * The `stats` region — the licensing figures.
     */
    response.assertTextIncludes('Active licenses')
    response.assertTextIncludes('Installations')

    /**
     * The `panels` region, and a row inside it. A panel title proves the
     * partial rendered; a row proves its data was loaded and passed through
     * as `widget.data`.
     */
    response.assertTextIncludes('Your licenses')
    response.assertTextIncludes('Invoice Pro')

    /**
     * No meters: the quota registry is empty since licence plan M5, and an
     * empty usage panel is hidden rather than rendered blank.
     */
    assert.notInclude(response.text(), 'Account usage')

    assert.notInclude(
      response.text(),
      'Register a widget in',
      'the empty-state hint is for an application with no widgets'
    )
  })

  /**
   * The seam, exercised rather than described: with nothing registered the
   * page must still render. A dashboard that 500s when a feature is removed
   * is the failure this registry exists to prevent (docs/modules.md).
   */
  test('renders without a single widget registered', async ({ client, assert }) => {
    const { user, organization } = await createWorkspace()
    await createLicense({ organization })

    const registered = dashboard.all()

    try {
      dashboard.reset()

      const response = await client.get('/dashboard').loginAs(user).withCsrfToken()

      response.assertStatus(200)
      response.assertTextIncludes('Register a widget in')

      assert.notInclude(response.text(), 'Your licenses')
      assert.notInclude(response.text(), 'Active licenses')
    } finally {
      dashboard.reset()
      registered.forEach((widget) => dashboard.register(widget))
    }
  })
})
