/**
 * Which expiry reminder a license is due, as a pure decision (licence plan
 * §5.5, M8).
 *
 * The reminder due is the **smallest** threshold the license has reached: a
 * license 2 days from expiry gets the 3-day email, never the 3-day and the
 * 14-day together, even if the job did not run for a week. Each threshold is
 * sent once per expiry date — a renewal that moves the date starts the cycle
 * again.
 */
export interface ReminderSent {
  days: number
  expiresAtMs: number
}

const DAY_MS = 86_400_000

export function reminderDue(input: {
  expiresAtMs: number
  nowMs: number
  thresholds: readonly number[]
  sent: readonly ReminderSent[]
}): number | null {
  const remainingMs = input.expiresAtMs - input.nowMs

  if (remainingMs <= 0) {
    return null
  }

  const reached = [...input.thresholds]
    .sort((a, b) => a - b)
    .find((days) => remainingMs <= days * DAY_MS)

  if (reached === undefined) {
    return null
  }

  const already = input.sent.some(
    (sent) => sent.expiresAtMs === input.expiresAtMs && sent.days <= reached
  )

  return already ? null : reached
}

/**
 * Whether a license keeps itself alive: tied to a subscription that is set to
 * renew. Anything else — no subscription, one cancelling at period end, one
 * already cancelled or failing to pay — expires unless somebody acts, and is
 * worth an email.
 */
export function renewsByItself(
  subscription: { status: string; cancelAtPeriodEnd: boolean } | null
): boolean {
  return (
    subscription !== null &&
    ['trialing', 'active'].includes(subscription.status) &&
    !subscription.cancelAtPeriodEnd
  )
}
