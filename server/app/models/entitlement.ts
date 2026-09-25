import { compose } from '@adonisjs/core/helpers'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import Product from '#models/product'
import { EntitlementSchema } from '#database/schema'
import { withPublicId } from '#models/mixins/with_public_id'
import type { EntitlementDefinition } from '#catalog/entitlements'

/**
 * A feature flag or limit a product's plans can grant (licence plan §4).
 */
export default class Entitlement extends compose(EntitlementSchema, withPublicId('entitlement')) {
  @belongsTo(() => Product)
  declare product: BelongsTo<typeof Product>

  toDefinition(): EntitlementDefinition {
    return { key: this.key, type: this.type, defaultValue: this.defaultValue ?? null }
  }
}
