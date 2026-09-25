import { compose } from '@adonisjs/core/helpers'
import { beforeCreate, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import Product from '#models/product'
import { PlanSchema } from '#database/schema'
import { withPublicId } from '#models/mixins/with_public_id'

/**
 * A price and the license it buys (licence plan §4).
 *
 * Not the starter's SaaS tier (`config/plans.ts`), which describes what an
 * organisation may do and is removed in M4.
 */
export default class Plan extends compose(PlanSchema, withPublicId('plan')) {
  @belongsTo(() => Product)
  declare product: BelongsTo<typeof Product>

  @beforeCreate()
  static applyDefaults(plan: Plan) {
    plan.status ??= 'active'
    plan.isPublic ??= true
    plan.sortOrder ??= 0
  }

  get isArchived() {
    return this.status === 'archived'
  }

  get isRecurring() {
    return this.billing !== 'one_time'
  }

  /**
   * `null` is unlimited, which reads as a word rather than a number wherever
   * it is shown.
   */
  get activationsLabel() {
    return this.maxActivations === null || this.maxActivations === undefined
      ? 'Unlimited'
      : String(this.maxActivations)
  }
}
