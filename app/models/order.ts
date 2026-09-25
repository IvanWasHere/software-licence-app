import { compose } from '@adonisjs/core/helpers'
import { beforeCreate, belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'

import License from '#models/license'
import OrderItem from '#models/order_item'
import Organization from '#models/organization'
import { OrderSchema } from '#database/schema'
import { withPublicId } from '#models/mixins/with_public_id'

/**
 * One checkout (licence plan §4, M4).
 */
export default class Order extends compose(OrderSchema, withPublicId('order')) {
  @belongsTo(() => Organization)
  declare organization: BelongsTo<typeof Organization>

  @hasMany(() => OrderItem)
  declare items: HasMany<typeof OrderItem>

  @hasMany(() => License)
  declare licenses: HasMany<typeof License>

  @beforeCreate()
  static applyDefaults(order: Order) {
    order.status ??= 'pending'
  }

  get isPaid() {
    return this.status !== 'pending'
  }

  get isFulfilled() {
    return Boolean(this.fulfilledAt)
  }
}
