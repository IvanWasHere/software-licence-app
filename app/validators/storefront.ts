import vine from '@vinejs/vine'

/**
 * The public pricing page's checkout form (licence plan §6, M5). The email is
 * only asked of a buyer who is not signed in.
 */
export const storefrontCheckoutValidator = vine.create({
  email: vine.string().trim().email().maxLength(254).optional(),
})
