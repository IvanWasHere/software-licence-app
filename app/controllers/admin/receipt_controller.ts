import type { HttpContext } from '@adonisjs/core/http'

import Payment from '#models/payment'
import receipts from '#billing/receipt_service'

/**
 * The receipt PDF for a charge, for staff (licence plan M9): what the
 * customer was sent, when they say they never got it. Support-level, like
 * the orders it sits beside.
 */
export default class ReceiptController {
  async download({ params, response, session, staffBouncer }: HttpContext) {
    await staffBouncer.with('StaffPolicy').authorize('view')

    const payment = await Payment.findBy('public_id', params.id)

    if (!payment) {
      session.flash('error', 'No such payment.')
      return response.redirect().toRoute('admin.orders.index')
    }

    const receipt = await receipts.issue(payment)
    const pdf = await receipts.pdf(receipt)

    return response
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${receipt.fileName}"`)
      .send(pdf)
  }
}
