import { test } from '@japa/runner'

import { findings, type LicenseUsage } from '#licensing/abuse'

/**
 * What looks like a shared key (licence plan §9, M8). Allowances grow with
 * the license, so a big legitimate customer is never flagged for being big.
 */
const LIMITS = {
  ipsPerDayFloor: 20,
  ipsPerDayPerSlot: 3,
  activationsPerDayFloor: 10,
  activationsPerDayPerSlot: 2,
  devSites: 25,
}
const TODAY = '2026-09-26'

const usage = (overrides: Partial<LicenseUsage> = {}): LicenseUsage => ({
  maxActivations: 3,
  liveActivations: 3,
  liveDevSites: 0,
  activationsLast24h: 0,
  distinctIpsByDay: {},
  ...overrides,
})

test.group('Abuse findings', () => {
  test('a normal license finds nothing', ({ assert }) => {
    assert.deepEqual(
      findings(usage({ distinctIpsByDay: { [TODAY]: 5 }, activationsLast24h: 2 }), TODAY, LIMITS),
      []
    )
  })

  test('too many addresses in a day, per day', ({ assert }) => {
    const found = findings(
      usage({ distinctIpsByDay: { '2026-09-25': 21, [TODAY]: 20 } }),
      TODAY,
      LIMITS
    )

    assert.deepEqual(found, [{ kind: 'many_ips', day: '2026-09-25', count: 21, allowance: 20 }])
  })

  test('the address allowance grows with the license', ({ assert }) => {
    const agency = usage({ maxActivations: 50, distinctIpsByDay: { [TODAY]: 140 } })
    assert.deepEqual(findings(agency, TODAY, LIMITS), [], '50 slots × 3 = 150')

    const unlimited = usage({
      maxActivations: null,
      liveActivations: 40,
      distinctIpsByDay: { [TODAY]: 100 },
    })
    assert.deepEqual(findings(unlimited, TODAY, LIMITS), [], 'unlimited is as big as it is used')

    const tiny = usage({ maxActivations: 1, liveActivations: 1, distinctIpsByDay: { [TODAY]: 21 } })
    assert.equal(findings(tiny, TODAY, LIMITS)[0].allowance, 20, 'never below the floor')
  })

  test('installations churning', ({ assert }) => {
    assert.deepEqual(findings(usage({ activationsLast24h: 10 }), TODAY, LIMITS), [])
    assert.deepEqual(findings(usage({ activationsLast24h: 11 }), TODAY, LIMITS), [
      { kind: 'activation_churn', day: TODAY, count: 11, allowance: 10 },
    ])
    assert.deepEqual(
      findings(usage({ maxActivations: 20, activationsLast24h: 35 }), TODAY, LIMITS),
      [],
      '20 slots × 2 = 40'
    )
  })

  test('many free development sites', ({ assert }) => {
    assert.deepEqual(findings(usage({ liveDevSites: 25 }), TODAY, LIMITS), [])
    assert.equal(findings(usage({ liveDevSites: 26 }), TODAY, LIMITS)[0].kind, 'many_dev_sites')
  })
})
