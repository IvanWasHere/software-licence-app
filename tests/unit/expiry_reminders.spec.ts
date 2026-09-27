import { test } from '@japa/runner'

import { reminderDue, renewsByItself } from '#licensing/expiry_reminders'

/**
 * Which expiry reminder is due (licence plan §5.5, M8).
 */
const DAY = 86_400_000
const NOW = Date.parse('2026-09-26T09:00:00Z')
const THRESHOLDS = [14, 3]

const due = (daysLeft: number, sent: { days: number; expiresAtMs: number }[] = []) =>
  reminderDue({ expiresAtMs: NOW + daysLeft * DAY, nowMs: NOW, thresholds: THRESHOLDS, sent })

test.group('Expiry reminders — which one is due', () => {
  test('nothing before the first threshold', ({ assert }) => {
    assert.isNull(due(30))
    assert.isNull(due(14.01))
  })

  test('the 14-day one inside two weeks, the 3-day one inside three days', ({ assert }) => {
    assert.equal(due(14), 14)
    assert.equal(due(10), 14)
    assert.equal(due(3), 3)
    assert.equal(due(0.5), 3)
  })

  test('only the smallest threshold reached — never two at once', ({ assert }) => {
    assert.equal(due(2), 3, 'a job that missed the 14-day window sends only the 3-day one')
  })

  test('each once per expiry date', ({ assert }) => {
    const expiresAtMs = NOW + 10 * DAY

    assert.isNull(due(10, [{ days: 14, expiresAtMs }]))
    assert.equal(due(2, [{ days: 14, expiresAtMs: NOW + 2 * DAY }]), 3)
    assert.isNull(due(2, [{ days: 3, expiresAtMs: NOW + 2 * DAY }]))
  })

  test('a renewal that moved the date starts again', ({ assert }) => {
    const oldExpiry = NOW - 20 * DAY
    assert.equal(
      due(10, [
        { days: 14, expiresAtMs: oldExpiry },
        { days: 3, expiresAtMs: oldExpiry },
      ]),
      14
    )
  })

  test('nothing once expired', ({ assert }) => {
    assert.isNull(due(0))
    assert.isNull(due(-1))
  })
})

test.group('Expiry reminders — which licenses renew by themselves', () => {
  test('only a subscription that is set to renew', ({ assert }) => {
    assert.isTrue(renewsByItself({ status: 'active', cancelAtPeriodEnd: false }))
    assert.isTrue(renewsByItself({ status: 'trialing', cancelAtPeriodEnd: false }))

    assert.isFalse(renewsByItself(null), 'no subscription: a fixed term')
    assert.isFalse(renewsByItself({ status: 'active', cancelAtPeriodEnd: true }))
    assert.isFalse(renewsByItself({ status: 'canceled', cancelAtPeriodEnd: false }))
    assert.isFalse(renewsByItself({ status: 'past_due', cancelAtPeriodEnd: false }))
  })
})
