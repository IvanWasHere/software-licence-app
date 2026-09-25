import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Releases (licence plan §4, §7.2, M7) — the builds a product ships, served to
 * customers' software as updates.
 *
 * The file lives on the private disk under `file_key`; the database stores
 * the key and its checksum, never a URL (the starter's storage rule). A
 * download is a short-lived signed URL, issued per request to a license that
 * is entitled to *this* release.
 *
 * `draft` is uploaded but not offered; `published` is offered; `yanked` was
 * published and then withdrawn — kept, because installs that already have it
 * should still be able to reinstall, but never offered as the latest again.
 */
export default class extends BaseSchema {
  protected tableName = 'releases'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('public_id', 32).notNullable().unique()

      table
        .integer('product_id')
        .notNullable()
        .references('id')
        .inTable('products')
        .onDelete('RESTRICT')
        .index()

      table.string('version', 64).notNullable()
      table.string('channel', 16).notNullable().defaultTo('stable')
      table.string('status', 16).notNullable().defaultTo('draft')
      table.text('changelog').nullable()

      /**
       * `{ wp: "6.5", php: "8.1" }` — what the WordPress updater shows and
       * checks. Free-form for other kinds of product.
       */
      table.json('requires').nullable()
      table.string('tested_up_to', 32).nullable()

      table.boolean('license_required').notNullable().defaultTo(true)

      table.string('file_key', 512).notNullable()
      table.string('file_name', 255).notNullable()
      table.bigInteger('file_size').notNullable()
      /**
       * SHA-256, hex. Not `checksum_sha256`: the ORM maps that property back
       * to `checksum_sha_256` (the `key_last4` trap).
       */
      table.string('checksum', 64).notNullable()

      table.timestamp('published_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()

      table.unique(['product_id', 'version'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
