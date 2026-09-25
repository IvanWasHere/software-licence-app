import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Products (licence plan §4) — each thing we sell a license for.
 *
 * `slug` is what the SDKs send on every call, so once a product has shipped
 * it is effectively permanent; `CatalogService` refuses to change it outside
 * `draft`. `key_prefix` is the readable head of every license key issued for
 * the product (`WIPRO-…`).
 *
 * The three client-policy columns are handed to the SDKs in every validate
 * response, which is how one product can re-check daily and another weekly
 * without shipping a new client.
 */
export default class extends BaseSchema {
  protected tableName = 'products'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('public_id', 32).notNullable().unique()

      table.string('slug', 64).notNullable().unique()
      table.string('name', 120).notNullable()
      table.text('description').nullable()
      table.string('status', 16).notNullable().defaultTo('draft')
      table.string('kind', 32).notNullable()
      table.string('key_prefix', 8).notNullable()
      table.string('homepage_url', 1024).nullable()
      table.string('docs_url', 1024).nullable()

      table.integer('validation_interval_hours').notNullable().defaultTo(24)
      table.integer('offline_grace_days').notNullable().defaultTo(7)
      table.boolean('count_dev_sites').notNullable().defaultTo(false)

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
