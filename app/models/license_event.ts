import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import License from '#models/license'
import { LicenseEventSchema } from '#database/schema'

/**
 * One entry in a license's history (licence plan §4). Append-only.
 */
export default class LicenseEvent extends LicenseEventSchema {
  @belongsTo(() => License)
  declare license: BelongsTo<typeof License>
}
