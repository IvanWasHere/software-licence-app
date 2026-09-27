import { compose } from '@adonisjs/core/helpers'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import License from '#models/license'
import StaffUser from '#models/staff_user'
import { LicenseFlagSchema } from '#database/schema'
import { withPublicId } from '#models/mixins/with_public_id'
import { FLAG_DESCRIPTIONS } from '#licensing/abuse'

/**
 * Something the abuse job thought worth a look (licence plan §9, M8). A flag
 * changes nothing about the license; staff decide.
 */
export default class LicenseFlag extends compose(LicenseFlagSchema, withPublicId('licenseFlag')) {
  @belongsTo(() => License)
  declare license: BelongsTo<typeof License>

  @belongsTo(() => StaffUser, { foreignKey: 'resolvedByStaffId' })
  declare resolvedBy: BelongsTo<typeof StaffUser>

  get isOpen() {
    return this.resolvedAt === null || this.resolvedAt === undefined
  }

  get description() {
    return FLAG_DESCRIPTIONS[this.kind] ?? this.kind
  }

  /**
   * "31 addresses on 2026-09-26, where 9 would be expected".
   */
  get summary() {
    const details = this.details ?? {}
    const unit =
      this.kind === 'many_ips'
        ? 'addresses'
        : this.kind === 'activation_churn'
          ? 'new activations in 24 hours'
          : 'live development sites'

    return `${details.count} ${unit} on ${this.day}, where up to ${details.allowance} would be expected`
  }
}
