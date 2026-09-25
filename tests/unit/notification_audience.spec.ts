import { test } from '@japa/runner'

import { appliesTo, describeAudience, type AudienceViewer } from '#notifications/audience'

/**
 * The audience predicate, exhaustively (plan §20.3, §20.7; licence plan M5).
 *
 * This is the one place in the application that decides something without an
 * `organization_id` filter, because crossing tenants *is* the feature. A bug
 * here shows one customer another customer's announcement and nothing
 * downstream would catch it — so this file enumerates every combination
 * rather than spot-checking.
 */
const INVOICE_PRO = 1
const BOOKING_PRO = 2

/**
 * The shapes an account's holdings take: nothing yet, one product, both.
 */
const HOLDINGS: readonly (readonly number[])[] = [[], [INVOICE_PRO], [INVOICE_PRO, BOOKING_PRO]]
const ROLES = ['owner', 'member'] as const

const viewer = (overrides: Partial<AudienceViewer> = {}): AudienceViewer => ({
  id: 1,
  role: 'member',
  productIds: [],
  ...overrides,
})

test.group('Audience — all', () => {
  test('reaches every role, whatever it holds', ({ assert }) => {
    for (const productIds of HOLDINGS) {
      for (const role of ROLES) {
        assert.isTrue(
          appliesTo({ audienceType: 'all', audience: null }, viewer({ role, productIds })),
          `${role} holding ${JSON.stringify(productIds)}`
        )
      }
    }
  })

  test('ignores an audience payload it does not need', ({ assert }) => {
    assert.isTrue(
      appliesTo({ audienceType: 'all', audience: { productIds: [INVOICE_PRO] } }, viewer())
    )
  })
})

test.group('Audience — customers of a product', () => {
  test('reaches every role holding a listed product, and nobody else', ({ assert }) => {
    const notification = {
      audienceType: 'product' as const,
      audience: { productIds: [INVOICE_PRO] },
    }

    for (const role of ROLES) {
      assert.isTrue(appliesTo(notification, viewer({ role, productIds: [INVOICE_PRO] })), role)
      assert.isTrue(
        appliesTo(notification, viewer({ role, productIds: [BOOKING_PRO, INVOICE_PRO] })),
        `${role} holding both`
      )
      assert.isFalse(appliesTo(notification, viewer({ role, productIds: [BOOKING_PRO] })), role)
      assert.isFalse(
        appliesTo(notification, viewer({ role, productIds: [] })),
        `${role} holding none`
      )
    }
  })

  test('several products at once', ({ assert }) => {
    const notification = {
      audienceType: 'product' as const,
      audience: { productIds: [INVOICE_PRO, BOOKING_PRO] },
    }

    assert.isTrue(appliesTo(notification, viewer({ productIds: [INVOICE_PRO] })))
    assert.isTrue(appliesTo(notification, viewer({ productIds: [BOOKING_PRO] })))
    assert.isFalse(appliesTo(notification, viewer({ productIds: [] })))
  })

  /**
   * Closed by default: an announcement that reaches nobody is a support
   * ticket, one that reaches everybody is an incident.
   */
  test('an empty product list reaches nobody, not everybody', ({ assert }) => {
    for (const audience of [{ productIds: [] }, {}, null]) {
      for (const productIds of HOLDINGS) {
        assert.isFalse(
          appliesTo({ audienceType: 'product', audience }, viewer({ productIds })),
          `${JSON.stringify(audience)} for ${JSON.stringify(productIds)}`
        )
      }
    }
  })

  test('a product that no longer exists matches nobody', ({ assert }) => {
    assert.isFalse(
      appliesTo(
        { audienceType: 'product', audience: { productIds: [999] } },
        viewer({ productIds: [INVOICE_PRO, BOOKING_PRO] })
      )
    )
  })
})

test.group('Audience — owners', () => {
  test('reaches owners whatever they hold, and no members at all', ({ assert }) => {
    const notification = { audienceType: 'owners' as const, audience: null }

    for (const productIds of HOLDINGS) {
      assert.isTrue(appliesTo(notification, viewer({ role: 'owner', productIds })))
      assert.isFalse(appliesTo(notification, viewer({ role: 'member', productIds })))
    }
  })

  /**
   * Unlike `product`, an empty list here means "every owner" — the type has
   * already narrowed the audience, so the list is a further filter rather
   * than the whole selection.
   */
  test('narrows by product when asked, and does not when not', ({ assert }) => {
    const every = { audienceType: 'owners' as const, audience: { productIds: [] } }
    const invoiceOnly = {
      audienceType: 'owners' as const,
      audience: { productIds: [INVOICE_PRO] },
    }

    assert.isTrue(appliesTo(every, viewer({ role: 'owner', productIds: [] })))
    assert.isTrue(appliesTo(invoiceOnly, viewer({ role: 'owner', productIds: [INVOICE_PRO] })))
    assert.isFalse(appliesTo(invoiceOnly, viewer({ role: 'owner', productIds: [BOOKING_PRO] })))

    /**
     * And still never a member, whatever they hold.
     */
    assert.isFalse(appliesTo(invoiceOnly, viewer({ role: 'member', productIds: [INVOICE_PRO] })))
  })
})

/**
 * The sharpest edge: a notification for one person must be invisible to
 * everybody else, including people in the same account.
 */
test.group('Audience — named users', () => {
  test('reaches exactly the ids listed', ({ assert }) => {
    const notification = { audienceType: 'users' as const, audience: { userIds: [7, 9] } }

    assert.isTrue(appliesTo(notification, viewer({ id: 7 })))
    assert.isTrue(appliesTo(notification, viewer({ id: 9 })))
    assert.isFalse(appliesTo(notification, viewer({ id: 8 })))
  })

  test('role and holdings do not widen it', ({ assert }) => {
    const notification = { audienceType: 'users' as const, audience: { userIds: [7] } }

    for (const productIds of HOLDINGS) {
      for (const role of ROLES) {
        assert.isFalse(
          appliesTo(notification, viewer({ id: 8, role, productIds })),
          `${role} holding ${JSON.stringify(productIds)} is still not user 7`
        )
      }
    }
  })

  test('an empty list reaches nobody', ({ assert }) => {
    for (const audience of [{ userIds: [] }, {}, null]) {
      assert.isFalse(appliesTo({ audienceType: 'users', audience }, viewer({ id: 7 })))
    }
  })

  /**
   * Ids are compared as numbers. A string that looks like one must not match,
   * or a hand-edited payload could widen an audience by accident.
   */
  test('does not match a string that looks like the id', ({ assert }) => {
    assert.isFalse(
      appliesTo(
        { audienceType: 'users', audience: { userIds: ['7' as unknown as number] } },
        viewer({ id: 7 })
      )
    )
  })
})

test.group('Audience — closed by default', () => {
  test('an unrecognised type reaches nobody', ({ assert }) => {
    assert.isFalse(
      appliesTo(
        { audienceType: 'everyone-forever' as never, audience: null },
        viewer({ role: 'owner', productIds: [INVOICE_PRO] })
      )
    )
  })

  /**
   * Rows written before M5 said `plan`. A migration moves them, and this is
   * what happens to one it missed.
   */
  test('the retired plan audience reaches nobody', ({ assert }) => {
    assert.isFalse(
      appliesTo(
        { audienceType: 'plan' as never, audience: null },
        viewer({ role: 'owner', productIds: [INVOICE_PRO] })
      )
    )
  })
})

test.group('Audience — how it reads in the back-office', () => {
  const names = new Map([
    [INVOICE_PRO, 'Invoice Pro'],
    [BOOKING_PRO, 'Booking Pro'],
  ])

  test('says who it reaches, not which enum was chosen', ({ assert }) => {
    assert.equal(describeAudience({ audienceType: 'all', audience: null }, names), 'Everyone')
    assert.equal(
      describeAudience({ audienceType: 'product', audience: { productIds: [INVOICE_PRO] } }, names),
      'Customers of Invoice Pro'
    )
    assert.equal(
      describeAudience({ audienceType: 'owners', audience: null }, names),
      'All account owners'
    )
    assert.equal(
      describeAudience({ audienceType: 'owners', audience: { productIds: [BOOKING_PRO] } }, names),
      'Owners with Booking Pro'
    )
    assert.equal(
      describeAudience({ audienceType: 'users', audience: { userIds: [1] } }, names),
      '1 named person'
    )
  })

  /**
   * The one that matters: an author who picked a product audience and no
   * products should be told so before they publish, not afterwards.
   */
  test('says plainly when a choice would reach nobody', ({ assert }) => {
    assert.equal(
      describeAudience({ audienceType: 'product', audience: { productIds: [] } }, names),
      'Nobody — no product chosen'
    )
  })
})
