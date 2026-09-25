/**
 * What a customer account may do (licence plan §2, M5).
 *
 * The starter sold tiers of a SaaS here — Free, Pro, Business — each with its
 * own limits and a price. A licensing customer buys *licenses*, not a tier, so
 * there is one account tier left: the limits that keep a single account from
 * costing us disproportionately (people, uploads, API traffic). What a
 * customer *bought* lives in the catalog and on their licenses, never here.
 *
 * Kept as a typed file rather than removed, because the machinery behind it
 * is still what enforces those limits — the row-locked checks, the meters,
 * the 402 — and because a staff override (`organizations.limit_overrides`)
 * is still how support says "give this agency fifty seats".
 *
 * Two magic values, and the difference matters:
 *   `null` — unlimited.
 *   `0`    — not available at all, so the feature's screen is hidden rather
 *            than shown empty.
 */
export interface PlanLimits {
  seats: number | null
  storageMb: number | null
  apiKeys: number | null
  apiCallsPerMonth: number | null
}

export interface PlanDefinition {
  name: string
  limits: PlanLimits
  features: readonly string[]
}

export const plans = {
  standard: {
    name: 'Standard',
    /**
     * Decided for M5:
     * - One person per account. A license is used by whoever installs it;
     *   an agency that needs a team gets a staff override.
     * - No uploads. Nothing a customer does here needs a file.
     * - No API keys by default. The organisation API is for the odd customer
     *   who asks, switched on per account by staff (`apiKeys` override).
     * - Unlimited calls for the keys that do exist: request volume is
     *   governed by the burst limit, not by a monthly allowance.
     */
    limits: {
      seats: 1,
      storageMb: 0,
      apiKeys: 0,
      apiCallsPerMonth: null,
    },
    features: ['api'],
  },
} as const satisfies Record<string, PlanDefinition>

export type PlanKey = keyof typeof plans
export type LimitKey = keyof (typeof plans)['standard']['limits']
export type FeatureKey = (typeof plans)[PlanKey]['features'][number]

export const DEFAULT_PLAN: PlanKey = 'standard'

/**
 * Every limit key, in the order `PlanLimits` declares them. The staff
 * override form and `overrideLimits`' own check read this same list.
 */
export const LIMIT_KEYS = Object.keys(plans[DEFAULT_PLAN].limits) as LimitKey[]

/**
 * How each limit is named to a customer, dropped into "You can have 10 …".
 * Exhaustive over `LimitKey`, so a limit without a word for it is a compile
 * error rather than a `402` that says "you have used all 5 apiKeys".
 */
export const LIMIT_NOUNS: Record<LimitKey, string> = {
  seats: 'seats',
  storageMb: 'MB of storage',
  apiKeys: 'API keys',
  apiCallsPerMonth: 'API calls this month',
}

/**
 * The noun for a limit, falling back to the key for a string that is not one
 * — an ugly message is a better failure than a 500 on top of a 402.
 */
export function nounFor(limit: string): string {
  return LIMIT_NOUNS[limit as LimitKey] ?? limit
}

/**
 * The tier for an account. Every key resolves to the one tier there is, so an
 * account still carrying a starter key (`free`, `pro`) is never locked out.
 */
export function planFor(planKey: string): PlanDefinition {
  return plans[planKey as PlanKey] ?? plans[DEFAULT_PLAN]
}

/**
 * A single limit for an account: the staff override when there is one, the
 * tier's otherwise.
 */
export function limitFor(
  organization: { planKey: string; limitOverrides: Record<string, number | null> | null },
  limit: LimitKey
): number | null {
  const override = organization.limitOverrides?.[limit]

  if (override !== undefined) {
    return override
  }

  return planFor(organization.planKey).limits[limit]
}
