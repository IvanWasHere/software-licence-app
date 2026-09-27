import logger from '@adonisjs/core/services/logger'
import type { HttpContext } from '@adonisjs/core/http'

import Payment from '#models/payment'
import licensingConfig from '#config/licensing'
import receipts from '#billing/receipt_service'
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

  /**
   * The receipt PDF for one charge (licence plan M9). Keyed by the payment,
   * so a charge from before receipts existed gets one on its first download.
   */
  async receipt({ params, response, session, organization }: HttpContext) {
    const payment = await Payment.query()
      .where('organization_id', organization.id)
      .where('public_id', params.id)
      .first()

    if (!payment) {
      session.flash('error', 'No such payment.')
      return response.redirect().toRoute('billing.index')
    }

    const receipt = await receipts.issue(payment)
    const pdf = await receipts.pdf(receipt)

    return response
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${receipt.fileName}"`)
      .send(pdf)
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
