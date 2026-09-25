/**
 * Which combinations of billing and license term mean something (licence plan
 * §4). Pure, so the rules are tested once and both the admin form and any
 * future API share them.
 */

export const PLAN_BILLINGS = ['one_time', 'monthly', 'yearly'] as const
export type PlanBilling = (typeof PLAN_BILLINGS)[number]

export const LICENSE_TERMS = ['perpetual', 'subscription', 'fixed_days'] as const
export type LicenseTerm = (typeof LICENSE_TERMS)[number]

export interface PlanShape {
  billing: PlanBilling
  licenseTerm: LicenseTerm
  termDays: number | null
  updatesDays: number | null
}

/**
 * Field → message for every rule the shape breaks; empty when it is valid.
 *
 * - A recurring plan's license lives exactly as long as the subscription, so
 *   it takes no term of its own.
 * - A one-time plan buys either a perpetual license or a fixed number of days.
 * - `updates_days` only means something on a perpetual license: a license
 *   that expires stops getting updates when it expires anyway.
 */
export function planShapeErrors(shape: PlanShape): Record<string, string> {
  const errors: Record<string, string> = {}
  const recurring = shape.billing !== 'one_time'

  if (recurring && shape.licenseTerm !== 'subscription') {
    errors.licenseTerm = 'A monthly or yearly plan must use the subscription term.'
  }

  if (!recurring && shape.licenseTerm === 'subscription') {
    errors.licenseTerm = 'A one-time plan is either perpetual or a fixed number of days.'
  }

  if (shape.licenseTerm === 'fixed_days' && !shape.termDays) {
    errors.termDays = 'A fixed-length license needs its length in days.'
  }

  if (shape.licenseTerm !== 'fixed_days' && shape.termDays) {
    errors.termDays = 'Only a fixed-length license takes a length in days.'
  }

  if (shape.licenseTerm !== 'perpetual' && shape.updatesDays) {
    errors.updatesDays = 'Update windows only apply to perpetual licenses.'
  }

  return errors
}
