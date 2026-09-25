import type { HttpContext } from '@adonisjs/core/http'

import { flashInputSafely } from '#auth/flash_input'

/**
 * Send a form back with messages next to the fields they are about — the same
 * `inputErrorsBag` shape a VineJS failure produces, so `@field.error()` renders
 * a service-level refusal exactly as it renders a validation one.
 *
 * For rules a validator cannot express because they span fields or depend on
 * stored state, e.g. "billing is fixed once the product has left draft".
 */
export function redirectBackWithErrors(ctx: HttpContext, errors: Record<string, string>) {
  flashInputSafely(ctx.session)

  ctx.session.flash(
    'inputErrorsBag',
    Object.fromEntries(Object.entries(errors).map(([field, message]) => [field, [message]]))
  )
  ctx.session.flash('error', 'That could not be saved — see the highlighted fields.')

  return ctx.response.redirect().back()
}
