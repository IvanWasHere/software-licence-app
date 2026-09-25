import vine from '@vinejs/vine'

/**
 * The integration API's request bodies (licence plan §6, M4). snake_case on
 * the wire.
 */

const slug = vine
  .string()
  .trim()
  .maxLength(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

export const checkoutValidator = vine.create({
  product: slug,
  plan: slug,

  /**
   * Who is buying — recorded on the order by us, and later the only thing a
   * payment is matched to an account by.
   */
  email: vine.string().trim().email().maxLength(254),

  /**
   * Where the provider sends the buyer afterwards: our own website's thank-you
   * page, which then polls `GET /orders/{id}`.
   */
  success_url: vine
    .string()
    .trim()
    .url({ require_protocol: true, protocols: ['https', 'http'] })
    .maxLength(1024),
})

export const customerLicensesValidator = vine.create({
  email: vine.string().trim().email().maxLength(254),
})
