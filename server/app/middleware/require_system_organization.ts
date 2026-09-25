import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

import { ApiException } from '#api/errors'

/**
 * The integration API (licence plan §6, M4) — checkout, orders, a customer's
 * licenses by email — is for **our own** website backend, never for a
 * customer's key. It creates orders for arbitrary addresses and looks
 * customers up by email, which no tenant may do.
 *
 * So it is gated on the account, not on a scope: only keys belonging to the
 * system organisation (`organizations.is_system`, minted by `node ace
 * licensing:integration-key`) get past this. A scope would be one checkbox on
 * a customer's key-creation form away from a cross-tenant leak.
 *
 * Runs after `apiKeyAuth`, which is what puts the organisation on the context.
 */
export default class RequireSystemOrganizationMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (!ctx.organization?.isSystem) {
      throw new ApiException(
        'forbidden',
        'This endpoint is only available to the integration key.',
        403
      )
    }

    return next()
  }
}
