import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import Plan from '#models/plan'
import Order from '#models/order'
import { OrderItemSchema } from '#database/schema'

/**
 * A plan bought in an order, at the price it had then (licence plan §4, M4).
 */
export default class OrderItem extends OrderItemSchema {
  @belongsTo(() => Order)
  declare order: BelongsTo<typeof Order>

  @belongsTo(() => Plan)
  declare plan: BelongsTo<typeof Plan>
}
