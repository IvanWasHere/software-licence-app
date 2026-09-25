import { DateTime } from 'luxon'
import { compose } from '@adonisjs/core/helpers'
import { beforeCreate, belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'

import Plan from '#models/plan'
import Order from '#models/order'
import Product from '#models/product'
import Organization from '#models/organization'
import Subscription from '#models/subscription'
import LicenseEvent from '#models/license_event'
import LicenseActivation from '#models/license_activation'
import { LicenseSchema } from '#database/schema'
import { withPublicId } from '#models/mixins/with_public_id'
import type { LicenseFacts } from '#licensing/validation'

/**
 * A license (licence plan §4, §5). Owned by a customer account — an
 * organisation (D1) — and scoped to one product.
 *
 * Validity is not a column. `LicenseService.evaluate` computes it from the
 * facts below on every call.
 */
export default class License extends compose(LicenseSchema, withPublicId('license')) {
  @belongsTo(() => Organization)
  declare organization: BelongsTo<typeof Organization>

  @belongsTo(() => Product)
  declare product: BelongsTo<typeof Product>

  @belongsTo(() => Plan)
  declare plan: BelongsTo<typeof Plan>

  @belongsTo(() => Subscription)
  declare subscription: BelongsTo<typeof Subscription>

  @belongsTo(() => Order)
  declare order: BelongsTo<typeof Order>

  @hasMany(() => LicenseActivation)
  declare activations: HasMany<typeof LicenseActivation>

  @hasMany(() => LicenseEvent)
  declare events: HasMany<typeof LicenseEvent>

  @beforeCreate()
  static applyDefaults(license: License) {
    license.status ??= 'active'
  }

  get isRevoked() {
    return this.status === 'revoked'
  }

  get isSuspended() {
    return this.status === 'suspended'
  }

  /**
   * Compared as milliseconds, never by ISO string (CONTRIBUTING, trap 3), and
   * tested for truthiness because an unassigned nullable is `undefined`
   * (trap 1).
   */
  get isExpired() {
    return Boolean(this.expiresAt) && this.expiresAt!.toMillis() <= DateTime.utc().toMillis()
  }

  get isPerpetual() {
    return !this.expiresAt
  }

  /**
   * What the UI shows before anybody asks to reveal the key.
   */
  get maskedKey() {
    return `•••••-•••••-•••••-•${this.keySuffix}`
  }

  get activationsLabel() {
    return this.maxActivations === null || this.maxActivations === undefined
      ? 'Unlimited'
      : String(this.maxActivations)
  }

  /**
   * The facts the pure validation needs. Takes what it cannot know from its
   * own row as arguments rather than assuming relations are preloaded.
   */
  toFacts(productSlug: string, subscriptionStatus: string | null): LicenseFacts {
    return {
      status: this.status,
      expiresAtMs: this.expiresAt ? this.expiresAt.toMillis() : null,
      productSlug,
      subscriptionStatus,
    }
  }
}
