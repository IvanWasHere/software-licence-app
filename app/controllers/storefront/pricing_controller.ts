import env from '#start/env'
import router from '@adonisjs/core/services/router'
import type { HttpContext } from '@adonisjs/core/http'

import Plan from '#models/plan'
import Product from '#models/product'
import Organization from '#models/organization'
import orders, { OrderError } from '#commerce/order_service'
import { storefrontCheckoutValidator } from '#validators/storefront'

/**
 * The public pricing page and its checkout (licence plan §6, M5).
 *
 * The same order flow the integration API drives, for when there is no
 * separate website in front: a product's public plans, a Buy button, and a
 * return page that waits for the webhook. A signed-in buyer's order goes
 * straight to their account; anybody else gives an email, and the account is
 * found or created from it when the payment is confirmed.
 */
export default class PricingController {
  /**
   * The home page (licence plan M5): every product on sale, each linking to
   * its pricing page. Drafts do not exist to the outside; retired products
   * are not for sale.
   */
  async index({ view }: HttpContext) {
    const products = await Product.query()
      .where('status', 'active')
      .preload('plans', (query) =>
        query
          .where('status', 'active')
          .where('is_public', true)
          .whereNotNull('provider_product_id')
          .orderBy('price_cents', 'asc')
      )
      .orderBy('name', 'asc')

    return view.render('pages/home', { products })
  }

  async show({ params, view, response }: HttpContext) {
    const product = await Product.query()
      .where('slug', String(params.product))
      .where('status', 'active')
      .preload('plans', (query) =>
        query
          .where('status', 'active')
          .where('is_public', true)
          .whereNotNull('provider_product_id')
          .orderBy('sort_order', 'asc')
          .orderBy('id', 'asc')
      )
      .preload('entitlements', (query) => query.orderBy('key', 'asc'))
      .first()

    if (!product) {
      return response.notFound(await view.render('pages/errors/not_found'))
    }

    return view.render('pages/storefront/pricing', { product })
  }

  async checkout({ params, request, response, session, auth }: HttpContext) {
    const product = await Product.query()
      .where('slug', String(params.product))
      .where('status', 'active')
      .first()
    const plan = product
      ? await Plan.query()
          .where('product_id', product.id)
          .where('slug', String(params.plan))
          .where('is_public', true)
          .first()
      : null

    if (!product || !plan) {
      session.flash('error', 'That plan is not on sale.')
      return response.redirect().back()
    }

    const payload = await request.validateUsing(storefrontCheckoutValidator)
    const user = auth.use('web').user ?? null
    const email = user?.email ?? payload.email

    if (!email) {
      session.flash('inputErrorsBag', { email: ['Enter the email your key should go to.'] })
      return response.redirect().back()
    }

    try {
      const { url } = await orders.startCheckout({
        plan,
        email,
        organization: user ? await Organization.find(user.organizationId) : null,
        successUrl: (order) =>
          `${env.get('APP_URL')}${router.makeUrl('storefront.return', {}, { qs: { order: order.publicId } })}`,
      })

      /**
       * Leaving the application: no forwarded query string (CONTRIBUTING,
       * trap 5).
       */
      return response.redirect().clearQs().toPath(url)
    } catch (error) {
      if (error instanceof OrderError) {
        session.flash('error', 'That plan cannot be bought online right now. Please contact us.')
        return response.redirect().back()
      }
      throw error
    }
  }

  /**
   * Where the provider sends the buyer back to. Grants nothing — anyone can
   * type this URL — it only shows whether the webhook has landed, and waits
   * for it if not.
   */
  async return({ request, view }: HttpContext) {
    const order = await orders.find(String(request.input('order', '')))

    return view.render('pages/storefront/return', { order })
  }

  /**
   * What the return page polls. Status only: never a key, never an email —
   * the order id is in a URL the buyer may share.
   */
  async status({ params, response }: HttpContext) {
    const order = await orders.find(String(params.order))

    return response.ok({
      status: order?.status ?? 'unknown',
      fulfilled: Boolean(order?.fulfilledAt),
    })
  }
}
