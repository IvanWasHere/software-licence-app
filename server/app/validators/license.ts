import vine from '@vinejs/vine'

/**
 * Back-office license request bodies (licence plan §8, M2).
 */

/**
 * `YYYY-MM-DD` from a date input. Read as the end of that day in UTC by the
 * controller, so "expires on the 30th" means the 30th is still good.
 */
const dateInput = vine
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)

export const issueLicenseValidator = vine.create({
  /**
   * Whatever identifies the customer on the ticket: an organisation's public
   * id or the email of one of its people.
   */
  customer: vine.string().trim().minLength(3).maxLength(254),
  plan: vine.string().trim().maxLength(32),
  expiresAt: dateInput.nullable().optional(),
  notes: vine.string().trim().maxLength(2000).nullable().optional(),
})

export const licenseReasonValidator = vine.create({
  reason: vine.string().trim().minLength(3).maxLength(500),
})

export const licenseExpiryValidator = vine.create({
  /**
   * Empty means "never expires".
   */
  expiresAt: dateInput.nullable().optional(),
})

export const licenseActivationsValidator = vine.create({
  /**
   * Empty means unlimited.
   */
  maxActivations: vine.number().withoutDecimals().range([1, 100_000]).nullable().optional(),
})
