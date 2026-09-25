import { test } from '@japa/runner'

import { planShapeErrors, type PlanShape } from '#catalog/plan_shape'
import {
  coerceEntitlementValue,
  resolveEntitlements,
  ENTITLEMENT_KEY_PATTERN,
  type EntitlementDefinition,
} from '#catalog/entitlements'

/**
 * The pure halves of the catalog (licence plan §4). Entitlement resolution is
 * what every validate response will carry, so its precedence is pinned here
 * case by case rather than trusted to the functional suite.
 */
test.group('Entitlements — coercion', () => {
  test('reads booleans the way forms and JSON send them', ({ assert }) => {
    for (const truthy of [true, 1, '1', 'true', 'on']) {
      assert.strictEqual(coerceEntitlementValue('boolean', truthy), true, String(truthy))
    }
    for (const falsy of [false, 0, '0', 'false', 'off']) {
      assert.strictEqual(coerceEntitlementValue('boolean', falsy), false, String(falsy))
    }
    assert.isUndefined(coerceEntitlementValue('boolean', 'yes please'))
    assert.isUndefined(coerceEntitlementValue('boolean', 2))
  })

  test('reads whole numbers and refuses anything else', ({ assert }) => {
    assert.strictEqual(coerceEntitlementValue('integer', '25'), 25)
    assert.strictEqual(coerceEntitlementValue('integer', ' -3 '), -3)
    assert.strictEqual(coerceEntitlementValue('integer', 0), 0)
    assert.isUndefined(coerceEntitlementValue('integer', '2.5'))
    assert.isUndefined(coerceEntitlementValue('integer', 2.5))
    assert.isUndefined(coerceEntitlementValue('integer', 'lots'))
    assert.isUndefined(coerceEntitlementValue('integer', true))
  })

  test('keeps strings as they are, up to 500 characters', ({ assert }) => {
    assert.strictEqual(coerceEntitlementValue('string', 'gold'), 'gold')
    assert.strictEqual(coerceEntitlementValue('string', ''), '')
    assert.isUndefined(coerceEntitlementValue('string', 'x'.repeat(501)))
    assert.isUndefined(coerceEntitlementValue('string', 5))
  })

  /**
   * "Not set" and "set to zero" are different answers: a plan that grants
   * `max_projects: 0` has decided something.
   */
  test('treats null and undefined as not set', ({ assert }) => {
    assert.isUndefined(coerceEntitlementValue('integer', null))
    assert.isUndefined(coerceEntitlementValue('boolean', undefined))
  })

  test('keys are lower snake case starting with a letter', ({ assert }) => {
    for (const key of ['pdf_export', 'api', 'max_projects2']) {
      assert.isTrue(ENTITLEMENT_KEY_PATTERN.test(key), key)
    }
    for (const key of ['PDF', '2fa', 'pdf-export', '_x', '', 'a'.repeat(65)]) {
      assert.isFalse(ENTITLEMENT_KEY_PATTERN.test(key), key)
    }
  })
})

test.group('Entitlements — resolution', () => {
  const definitions: EntitlementDefinition[] = [
    { key: 'pdf_export', type: 'boolean', defaultValue: null },
    { key: 'white_label', type: 'boolean', defaultValue: true },
    { key: 'max_projects', type: 'integer', defaultValue: 3 },
    { key: 'tier', type: 'string', defaultValue: null },
  ]

  test('falls back to the default, then to the type’s zero value', ({ assert }) => {
    assert.deepEqual(resolveEntitlements(definitions, null), {
      pdf_export: false,
      white_label: true,
      max_projects: 3,
      tier: '',
    })
  })

  test('a plan value beats the default', ({ assert }) => {
    const resolved = resolveEntitlements(definitions, { pdf_export: true, max_projects: 0 })

    assert.isTrue(resolved.pdf_export)
    assert.strictEqual(resolved.max_projects, 0)
  })

  test('a license override beats the plan', ({ assert }) => {
    const resolved = resolveEntitlements(
      definitions,
      { max_projects: 10, white_label: false },
      { max_projects: 50 }
    )

    assert.strictEqual(resolved.max_projects, 50)
    assert.isFalse(resolved.white_label)
  })

  /**
   * A key left in a plan's map after its definition was deleted must not
   * reach clients, and a value stored with the wrong type is read as absent
   * rather than passed through.
   */
  test('drops undefined keys and ignores values of the wrong type', ({ assert }) => {
    const resolved = resolveEntitlements(definitions, {
      removed_feature: true,
      max_projects: 'many',
    })

    assert.notProperty(resolved, 'removed_feature')
    assert.strictEqual(resolved.max_projects, 3)
  })
})

test.group('Plan shape', () => {
  const shape = (overrides: Partial<PlanShape>): PlanShape => ({
    billing: 'yearly',
    licenseTerm: 'subscription',
    termDays: null,
    updatesDays: null,
    ...overrides,
  })

  test('accepts the meaningful combinations', ({ assert }) => {
    for (const valid of [
      shape({}),
      shape({ billing: 'monthly' }),
      shape({ billing: 'one_time', licenseTerm: 'perpetual' }),
      shape({ billing: 'one_time', licenseTerm: 'perpetual', updatesDays: 365 }),
      shape({ billing: 'one_time', licenseTerm: 'fixed_days', termDays: 30 }),
    ]) {
      assert.deepEqual(planShapeErrors(valid), {}, JSON.stringify(valid))
    }
  })

  test('a recurring plan must follow its subscription', ({ assert }) => {
    assert.property(planShapeErrors(shape({ licenseTerm: 'perpetual' })), 'licenseTerm')
    assert.property(
      planShapeErrors(shape({ billing: 'monthly', licenseTerm: 'fixed_days', termDays: 30 })),
      'licenseTerm'
    )
  })

  test('a one-time plan cannot follow a subscription', ({ assert }) => {
    assert.property(planShapeErrors(shape({ billing: 'one_time' })), 'licenseTerm')
  })

  test('a fixed term needs its length, and only it takes one', ({ assert }) => {
    assert.property(
      planShapeErrors(shape({ billing: 'one_time', licenseTerm: 'fixed_days' })),
      'termDays'
    )
    assert.property(
      planShapeErrors(shape({ billing: 'one_time', licenseTerm: 'perpetual', termDays: 30 })),
      'termDays'
    )
  })

  test('update windows are for perpetual licenses only', ({ assert }) => {
    assert.property(planShapeErrors(shape({ updatesDays: 365 })), 'updatesDays')
  })
})
