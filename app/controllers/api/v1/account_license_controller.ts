import type { HttpContext } from '@adonisjs/core/http'

import License from '#models/license'
import { sendItem, sendPage } from '#api/responses'
import { ApiNotFoundException } from '#api/errors'
import { requireScope } from '#middleware/api_key_auth'
import { decodeCursor, pageSize, toCursorPage } from '#api/cursor'
import LicenseTransformer from '#transformers/license_transformer'

/**
 * `GET /api/v1/licenses` and `GET /api/v1/licenses/{id}` on the organisation
 * API (licence plan M5) — a customer's own licenses, for their tooling.
 *
 * The key is the scope, as everywhere on this API: every query filters on the
 * calling key's organisation, and another account's license id is a 404
 * exactly like one that does not exist.
 *
 * Not to be confused with the public license API's `POST /licenses/validate`
 * and friends, which are keyless and called by the software itself.
 */
export default class AccountLicenseController {
  async index(ctx: HttpContext) {
    requireScope(ctx, 'licenses:read')

    const limit = pageSize(ctx.request.input('limit'))
    const after = decodeCursor(ctx.request.input('cursor'))

    const query = License.query()
      .where('organization_id', ctx.organization.id)
      .preload('product')
      .preload('plan')
      .orderBy('id', 'asc')
      .limit(limit + 1)

    if (after) {
      query.where('id', '>', after)
    }

    const page = toCursorPage(await query, limit)

    return sendPage(ctx, LicenseTransformer.transform(page.rows), {
      nextCursor: page.nextCursor,
      limit,
    })
  }

  async show(ctx: HttpContext) {
    requireScope(ctx, 'licenses:read')

    const license = await License.query()
      .where('organization_id', ctx.organization.id)
      .where('public_id', String(ctx.params.id))
      .preload('product')
      .preload('plan')
      .first()

    if (!license) {
      throw new ApiNotFoundException()
    }

    return sendItem(ctx, LicenseTransformer.transform(license))
  }
}
