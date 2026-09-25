import { compose } from '@adonisjs/core/helpers'
import { beforeCreate, hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'

import Plan from '#models/plan'
import Release from '#models/release'
import Entitlement from '#models/entitlement'
import { ProductSchema } from '#database/schema'
import { withPublicId } from '#models/mixins/with_public_id'

/**
 * Something we sell licenses for (licence plan §4).
 */
export default class Product extends compose(ProductSchema, withPublicId('product')) {
  @hasMany(() => Plan)
  declare plans: HasMany<typeof Plan>

  @hasMany(() => Entitlement)
  declare entitlements: HasMany<typeof Entitlement>

  @hasMany(() => Release)
  declare releases: HasMany<typeof Release>

  /**
   * The columns with database defaults, set here too: a default the database
   * applies is `undefined` on the model that inserted the row (CONTRIBUTING,
   * trap 6), and these are read straight back into the SDK policy.
   */
  @beforeCreate()
  static applyDefaults(product: Product) {
    product.status ??= 'draft'
    product.validationIntervalHours ??= 24
    product.offlineGraceDays ??= 7
    product.countDevSites ??= false
  }

  get isDraft() {
    return this.status === 'draft'
  }

  get isActive() {
    return this.status === 'active'
  }
}
