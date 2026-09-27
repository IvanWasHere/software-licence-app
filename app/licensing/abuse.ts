/**
 * What looks like a shared or leaked key (licence plan §9, M8), as a pure
 * decision over numbers the abuse job collects.
 *
 * Every rule is an **allowance that grows with the license**: a 1-site key
 * seen from 30 addresses in a day is being passed around; a 50-site agency
 * key is just busy. Findings are for a human — the job flags and notifies,
 * and never suspends or revokes (§9).
 */
export const LICENSE_FLAG_KINDS = ['many_ips', 'activation_churn', 'many_dev_sites'] as const

export type LicenseFlagKind = (typeof LICENSE_FLAG_KINDS)[number]

export const FLAG_DESCRIPTIONS: Record<LicenseFlagKind, string> = {
  many_ips: 'Used from more addresses in a day than its size explains',
  activation_churn: 'Activated on many new installations in 24 hours',
  many_dev_sites: 'Installed on an unusual number of development sites',
}

export interface AbuseThresholds {
  ipsPerDayFloor: number
  ipsPerDayPerSlot: number
  activationsPerDayFloor: number
  activationsPerDayPerSlot: number
  devSites: number
}

export interface LicenseUsage {
  /** The license's activation limit; `null` is unlimited. */
  maxActivations: number | null
  /** Live, non-dev activations — the size of an unlimited license. */
  liveActivations: number
  liveDevSites: number
  /** Activations created in the last 24 hours, dev or not. */
  activationsLast24h: number
  /** Distinct addresses per UTC day. */
  distinctIpsByDay: Record<string, number>
}

export interface Finding {
  kind: LicenseFlagKind
  day: string
  count: number
  allowance: number
}

export function findings(usage: LicenseUsage, today: string, limits: AbuseThresholds): Finding[] {
  /**
   * An unlimited license is as big as it is actually being used; a limited
   * one is as big as it is allowed to be, whichever is larger.
   */
  const slots = Math.max(usage.maxActivations ?? 0, usage.liveActivations, 1)
  const found: Finding[] = []

  const ipAllowance = Math.max(limits.ipsPerDayFloor, slots * limits.ipsPerDayPerSlot)

  for (const [day, count] of Object.entries(usage.distinctIpsByDay).sort()) {
    if (count > ipAllowance) {
      found.push({ kind: 'many_ips', day, count, allowance: ipAllowance })
    }
  }

  const churnAllowance = Math.max(
    limits.activationsPerDayFloor,
    slots * limits.activationsPerDayPerSlot
  )

  if (usage.activationsLast24h > churnAllowance) {
    found.push({
      kind: 'activation_churn',
      day: today,
      count: usage.activationsLast24h,
      allowance: churnAllowance,
    })
  }

  if (usage.liveDevSites > limits.devSites) {
    found.push({
      kind: 'many_dev_sites',
      day: today,
      count: usage.liveDevSites,
      allowance: limits.devSites,
    })
  }

  return found
}
