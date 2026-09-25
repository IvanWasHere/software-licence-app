import { compose } from '@adonisjs/core/helpers'
import { beforeCreate, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import File from '#models/file'
import Product from '#models/product'
import { ReleaseSchema } from '#database/schema'
import { withPublicId } from '#models/mixins/with_public_id'

/**
 * A build of a product, offered to its customers' software as an update
 * (licence plan §4, M7).
 */
export default class Release extends compose(ReleaseSchema, withPublicId('release')) {
  @belongsTo(() => Product)
  declare product: BelongsTo<typeof Product>

  /**
   * Database defaults, set here too so the model that inserted the row can
   * read them (CONTRIBUTING, trap 6).
   */
  @beforeCreate()
  static applyDefaults(release: Release) {
    release.status ??= 'draft'
    release.channel ??= 'stable'
    release.licenseRequired ??= true
  }

  get isDraft() {
    return this.status === 'draft'
  }

  get isPublished() {
    return this.status === 'published'
  }

  get isYanked() {
    return this.status === 'yanked'
  }

  /**
   * `WordPress 6.5, PHP 7.4` — for the back-office list.
   */
  get requiresLabel() {
    return Object.entries(this.requires ?? {})
      .map(([name, version]) => `${name === 'wp' ? 'WordPress' : name.toUpperCase()} ${version}`)
      .join(', ')
  }

  get sizeLabel() {
    return File.formatBytes(this.fileSize)
  }
}
