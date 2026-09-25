import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'

import plans from '#billing/plan_service'
import { LIMIT_KEYS, LIMIT_NOUNS, plans as catalogue, type LimitKey } from '#config/plans'
import PlanLimitExceededException from '#exceptions/plan_limit_exceeded_exception'
import UpgradeRequiredException from '#exceptions/upgrade_required_exception'
import { addMember, createWorkspace } from '#tests/helpers'

/**
 * Account limits (licence plan M5): one tier, every limit, and the staff
 * overrides that move them. What a customer *bought* lives on their licenses;
 * these are the limits that keep one account from costing us
 * disproportionately — and a limit silently missing is how somebody gets
 * unlimited seats for nothing.
 */
test.group('PlanService — account limits', () => {
  const account = (limitOverrides: Record<string, number | null> | null = null) =>
    ({ planKey: 'standard', limitOverrides }) as any

  test('the tier defines every limit, and each reads back', ({ assert }) => {
    for (const key of LIMIT_KEYS) {
      assert.property(catalogue.standard.limits, key)
      assert.strictEqual(
        plans.limit(account(), key as LimitKey),
        catalogue.standard.limits[key as LimitKey],
        key
      )
    }
  })

  /**
   * The noun belongs to the limit, not the quota registry — reading it off
   * the registry instead is what produced "you have used all 5 apiKeys".
   */
  test('every limit has a noun, and a blocked create uses it', ({ assert }) => {
    for (const key of LIMIT_KEYS) {
      assert.isString(LIMIT_NOUNS[key], key)
    }

    assert.equal(
      PlanLimitExceededException.messageFor({ limit: 'apiKeys', allowed: 5, current: 5 }),
      'Your account allows 5 API keys, and you are using 5.'
    )

    /**
     * `0` is "switched off", which is a different sentence.
     */
    assert.equal(
      PlanLimitExceededException.messageFor({ limit: 'apiKeys', allowed: 0, current: 0 }),
      'API keys are switched off for your account.'
    )
  })

  /**
   * `null` is unlimited; `0` is off, so the screen is hidden rather than shown
   * empty. Collapsing the two is the bug this test exists to catch.
   */
  test('unlimited is not the same as unavailable', ({ assert }) => {
    assert.isNull(plans.limit(account({ seats: null }), 'seats'))
    assert.equal(plans.limit(account({ apiKeys: 0 }), 'apiKeys'), 0)

    assert.isTrue(plans.isWithinLimit(account({ seats: null }), 'seats', 10_000))
    assert.isFalse(plans.isWithinLimit(account({ apiKeys: 0 }), 'apiKeys', 1))
  })

  test('a limit is the count after the create, so the cap itself still fits', ({ assert }) => {
    const capped = account({ seats: 3 })

    assert.isTrue(plans.isWithinLimit(capped, 'seats', 3), 'the third seat fits')
    assert.isFalse(plans.isWithinLimit(capped, 'seats', 4), 'the fourth does not')
  })

  test('a staff override moves one limit and leaves the others alone', ({ assert }) => {
    assert.equal(plans.limit(account({ seats: 50 }), 'seats'), 50)
    assert.equal(plans.limit(account({ seats: 50 }), 'apiKeys'), catalogue.standard.limits.apiKeys)
  })

  /**
   * Accounts created before M5 carry `free`, `pro` or `business`. Every key
   * resolves to the one tier, so none of them is locked out.
   */
  test('a starter tier key still resolves to the account tier', ({ assert }) => {
    for (const key of ['free', 'pro', 'business', 'never-existed']) {
      assert.equal(plans.planFor({ planKey: key }).name, 'Standard', key)
      assert.equal(plans.planKeyFor({ planKey: key }), 'standard', key)
    }
  })

  test('features gate, and a missing one is a 402', ({ assert }) => {
    assert.isTrue(plans.can(account(), 'api'))
    assert.isFalse(plans.can(account(), 'sso'))

    try {
      plans.assertCan(account(), 'sso')
      assert.fail('should have thrown')
    } catch (error) {
      assert.instanceOf(error, UpgradeRequiredException)
      assert.equal((error as UpgradeRequiredException).status, 402)
    }
  })

  test('assertWithinLimit carries the numbers the screen renders', ({ assert }) => {
    try {
      plans.assertWithinLimit(account({ seats: 3 }), 'seats', 4)
      assert.fail('should have thrown')
    } catch (error) {
      assert.instanceOf(error, PlanLimitExceededException)

      const details = (error as PlanLimitExceededException).details
      assert.equal(details.limit, 'seats')
      assert.equal(details.allowed, 3)
      assert.equal(details.current, 3)
      assert.equal((error as PlanLimitExceededException).status, 402)
    }
  })
})

/**
 * The meter arithmetic (plan §7.4). No quota is registered since licence plan
 * M5, but the rules a meter follows are kept — and pinned — for the day one is.
 */
test.group('PlanService — meters', () => {
  test('turns amber at 80% and full at the cap', ({ assert }) => {
    assert.isFalse(plans.describeCount(3, 5).isNearLimit, '3 of 5 is 60%')
    assert.isTrue(plans.describeCount(4, 5).isNearLimit, '4 of 5 is exactly 80%')
    assert.isFalse(plans.describeCount(4, 5).isFull)
    assert.isTrue(plans.describeCount(5, 5).isFull)
    assert.equal(plans.describeCount(5, 5).remaining, 0)
  })

  /**
   * Lowering a limit can leave usage *above* the ceiling. That must read as
   * full rather than as negative headroom (plan §7.4, soft-lock).
   */
  test('usage above the ceiling reads as full, not as negative headroom', ({ assert }) => {
    const usage = plans.describeCount(4, 2)

    assert.equal(usage.remaining, 0, 'clamped, never negative')
    assert.isTrue(usage.isFull)
  })

  test('an unlimited limit never reads as full or near', ({ assert }) => {
    const usage = plans.describeCount(10_000, null)

    assert.isNull(usage.remaining)
    assert.isFalse(usage.isFull)
    assert.isFalse(usage.isNearLimit)
  })
})

test.group('PlanService — usage', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('reports no meters while no quota is registered', async ({ assert }) => {
    const { user, organization } = await createWorkspace()
    await addMember(organization, user, 'sam@example.com')

    const usage = await plans.usage(organization)

    assert.isEmpty(usage.meters)
    assert.isEmpty(usage.atCap)
  })
})
