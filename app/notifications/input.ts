import type Notification from '#models/notification'

/**
 * What an authoring form may say about an audience, before it is trusted.
 */
export interface AudienceInput {
  productIds?: unknown
  userIds?: unknown
}

/**
 * Reduce a submitted audience to the shape the predicate expects, keeping
 * only what the chosen type actually uses (plan §20.3).
 *
 * Two jobs, and the second is the important one:
 *
 * 1. Drop anything unrecognised — an id that is not a positive integer.
 * 2. **Drop the fields the type does not use.** An author who picks `users`
 *    after ticking products must not leave a `productIds` list behind in the
 *    row: it would be invisible in the UI, ignored by the predicate today,
 *    and quietly wrong the day somebody widens the rule.
 */
export function normalizeAudience(
  audienceType: Notification['audienceType'],
  input: AudienceInput | null | undefined
): Notification['audience'] {
  const productIds = toIds(input?.productIds)
  const userIds = toIds(input?.userIds)

  switch (audienceType) {
    case 'all':
      return null

    case 'product':
      return { productIds }

    case 'owners':
      /**
       * Optional here: no products means "every owner".
       */
      return productIds.length ? { productIds } : null

    case 'users':
      return { userIds }

    default:
      return null
  }
}

function toIds(value: unknown): number[] {
  const submitted = Array.isArray(value) ? value : value === undefined ? [] : [value]

  const ids = submitted
    .map((entry) => Number(entry))
    .filter((entry) => Number.isSafeInteger(entry) && entry > 0)

  return [...new Set(ids)]
}
