import { compose } from '@adonisjs/core/helpers'
import { beforeCreate, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import License from '#models/license'
import { LicenseActivationSchema } from '#database/schema'
import { withPublicId } from '#models/mixins/with_public_id'

/**
 * One installation using a license (licence plan §5.2).
 */
export default class LicenseActivation extends compose(
  LicenseActivationSchema,
  withPublicId('licenseActivation')
) {
  @belongsTo(() => License)
  declare license: BelongsTo<typeof License>

  @beforeCreate()
  static applyDefaults(activation: LicenseActivation) {
    activation.isDev ??= false
  }

  get isLive() {
    return !this.deactivatedAt
  }

  /**
   * What to call it on a screen: the site, else the label the client gave,
   * else the instance id — a desktop app has no site.
   */
  get displayName() {
    return this.hostname || this.label || this.instanceId
  }
}
