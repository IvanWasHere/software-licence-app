import type { HttpContext } from '@adonisjs/core/http'

import Order from '#models/order'
import License from '#models/license'
import Payment from '#models/payment'

/**
 * Orders in the back-office (licence plan §8, M4). Read-only: the ticket this
 * answers is "I paid and got no key", and the answer is on this screen —
 * pending (the webhook has not landed), paid with a license (the email went
 * somewhere), or paid without one (a fulfilment failure, visible in the
 * webhook ledger).
 */
export default class AdminOrderController {
  async index({ request, view, staffBouncer }: HttpContext) {
    await staffBouncer.with('StaffPolicy').authorize('view')

    const term = String(request.input('q', '')).trim().toLowerCase()
    const query = Order.query().preload('organization').orderBy('id', 'desc').limit(100)

    if (term.startsWith('ord_')) {
      query.where('public_id', term)
    } else if (term) {
      query.where('email', term)
    }

    return view.render('pages/admin/orders/index', { term, orders: await query })
  }

  async show({ params, view, response, session, staffBouncer }: HttpContext) {
    await staffBouncer.with('StaffPolicy').authorize('view')

    const order = await Order.query()
      .where('public_id', params.id)
      .preload('organization')
      .preload('items', (items) => items.preload('plan', (plan) => plan.preload('product')))
      .first()

    if (!order) {
      session.flash('error', 'No such order.')
      return response.redirect().toRoute('admin.orders.index')
    }

    const [licenses, payment] = await Promise.all([
      License.query().where('order_id', order.id).preload('product').orderBy('id', 'asc'),
      order.providerOrderId
        ? Payment.query().where('provider_order_id', order.providerOrderId).first()
        : null,
    ])

    return view.render('pages/admin/orders/show', { order, licenses, payment })
  }
}
