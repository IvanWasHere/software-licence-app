import type { HttpContext } from '@adonisjs/core/http'

import Product from '#models/product'
import { ApiNotFoundException } from '#api/errors'
import { policyFor } from '#licensing/api_payload'

/**
 * `GET /api/v1/products/:slug` (licence plan §6) — what a pricing page or an
 * SDK needs to know about a product without holding a key.
 *
 * Drafts are invisible: a product nobody can buy yet does not exist to the
 * outside. Retired products are still described, because their licenses
 * still validate and their SDKs still ask.
 */
export default class ProductApiController {
  async show({ params, response }: HttpContext) {
    const product = await Product.query()
      .where('slug', String(params.slug))
      .whereNot('status', 'draft')
      .preload('plans', (query) =>
        query
          .where('status', 'active')
          .where('is_public', true)
          .orderBy('sort_order', 'asc')
          .orderBy('id', 'asc')
      )
      .first()

    if (!product) {
      throw new ApiNotFoundException()
    }

    return response.ok({
      data: {
        slug: product.slug,
        name: product.name,
        kind: product.kind,
        status: product.status,
        description: product.description,
        homepage_url: product.homepageUrl,
        docs_url: product.docsUrl,
        policy: policyFor(product),

        /**
         * Only what is on sale, and only what a buyer needs to choose.
         * Retired products list none.
         */
        plans:
          product.status === 'active'
            ? product.plans.map((plan) => ({
                slug: plan.slug,
                name: plan.name,
                billing: plan.billing,
                price_cents: plan.priceCents,
                currency: plan.currency,
                license_term: plan.licenseTerm,
                term_days: plan.termDays,
                updates_days: plan.updatesDays,
                max_activations: plan.maxActivations,
              }))
            : [],
      },
    })
  }
}
