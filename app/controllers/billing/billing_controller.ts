import logger from '@adonisjs/core/services/logger'
import type { HttpContext } from '@adonisjs/core/http'

import licensingConfig from '#config/licensing'
import billing, { BillingError } from '#billing/billing_service'

/**
 * The owner's billing screen (licence plan §6, M5): orders, subscriptions,
 * payments, and the provider's portal. Owner-only, by middleware on the
 * route group (plan §6).
 */
export default class BillingController {
  async index({ view, organization }: HttpContext) {
    return view.render('pages/billing/index', {
      ...(await billing.overview(organization)),
      renewalGraceDays: licensingConfig.renewalGraceDays,
    })
  }

  async portal({ response, session, organization }: HttpContext) {
    try {
      const { url } = await billing.startPortal(organization)

      return response.redirect().clearQs().toPath(url)
    } catch (error) {
      if (error instanceof BillingError) {
        session.flash('error', error.message)
        return response.redirect().toRoute('billing.index')
      }

      logger.error({ err: error, organizationId: organization.id }, 'billing portal failed')

      session.flash('error', 'We could not open the billing portal just now. Please try again.')
      return response.redirect().toRoute('billing.index')
    }
  }
}
