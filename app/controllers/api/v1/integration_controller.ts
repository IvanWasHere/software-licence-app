import type { HttpContext } from '@adonisjs/core/http'

import Plan from '#models/plan'
import User from '#models/user'
import License from '#models/license'
import Product from '#models/product'
import orders, { OrderError } from '#commerce/order_service'
import { ApiException, ApiNotFoundException } from '#api/errors'
import { checkoutValidator, customerLicensesValidator } from '#validators/integration_api'

/**
 * The integration API (licence plan §6, M4): what our own website backend
 * calls to sell and to answer "where is my key?".
 *
 * Behind `systemOrganization` — only the system account's key reaches any of
 * this. Keys never leave through it: licenses are described by their suffix,
 * and the key itself goes to the buyer's inbox and their account.
 */
export default class IntegrationController {
  /**
   * `POST /api/v1/checkout` — a pending order and the provider's checkout
   * URL to send the buyer to.
   */
  async checkout({ request, response }: HttpContext) {
    const payload = await request.validateUsing(checkoutValidator)

    const product = await Product.findBy('slug', payload.product)
    const plan = product
      ? await Plan.query().where('product_id', product.id).where('slug', payload.plan).first()
      : null

    if (!plan) {
      throw new ApiNotFoundException('No such product and plan.')
    }

    try {
      const { order, url } = await orders.startCheckout({
        plan,
        email: payload.email,
        successUrl: payload.success_url,
      })

      return response.created({
        data: { order_id: order.publicId, status: order.status, checkout_url: url },
      })
    } catch (error) {
      if (error instanceof OrderError) {
        throw new ApiException('validation_failed', error.message, 422, { reason: error.reason })
      }
      throw error
    }
  }

  /**
   * `GET /api/v1/orders/{id}` — for the thank-you page to poll until the
   * webhook has landed. `status: pending` until then; the return from
   * checkout grants nothing by itself.
   */
  async order({ params, response }: HttpContext) {
    const order = await orders.find(String(params.id))

    if (!order) {
      throw new ApiNotFoundException()
    }

    const licenses = await License.query()
      .where('order_id', order.id)
      .preload('product')
      .preload('plan')
      .orderBy('id', 'asc')

    return response.ok({
      data: {
        id: order.publicId,
        status: order.status,
        email: order.email,
        total_cents: order.totalCents,
        currency: order.currency,
        paid_at: order.paidAt?.toUTC().toISO() ?? null,
        fulfilled_at: order.fulfilledAt?.toUTC().toISO() ?? null,
        licenses: licenses.map((license) => this.license(license)),
      },
    })
  }

  /**
   * `GET /api/v1/customers/licenses?email=` — a customer's licenses, for a
   * "resend my key" form or support tooling on the website.
   */
  async customerLicenses({ request, response }: HttpContext) {
    const { email } = await request.validateUsing(customerLicensesValidator, {
      data: request.qs(),
    })

    const user = await User.query()
      .where('email', email.toLowerCase())
      .whereNull('deleted_at')
      .first()

    const licenses = user
      ? await License.query()
          .where('organization_id', user.organizationId)
          .preload('product')
          .preload('plan')
          .orderBy('id', 'desc')
      : []

    return response.ok({ data: licenses.map((license) => this.license(license)) })
  }

  private license(license: License) {
    return {
      id: license.publicId,
      product: license.product.slug,
      plan: license.plan.slug,
      key_suffix: license.keySuffix,
      status: license.status,
      expires_at: license.expiresAt?.toUTC().toISO() ?? null,
    }
  }
}
