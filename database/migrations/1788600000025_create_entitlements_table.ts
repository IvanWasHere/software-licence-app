import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Entitlements (licence plan §4) — the feature flags and numeric limits a
 * product's plans can grant, e.g. `pdf_export` or `max_projects`.
 *
 * A definition belongs to one product and carries the type and the value a
 * plan gets when it says nothing. The per-plan values live on `plans` as a
 * JSON map keyed by `key`, resolved against these rows — so deleting a
 * definition removes it from every validate response at once, and a stale key
 * left in a plan's map is ignored rather than leaked.
 */
export default class extends BaseSchema {
  protected tableName = 'entitlements'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('public_id', 32).notNullable().unique()

      table
        .integer('product_id')
        .notNullable()
        .references('id')
        .inTable('products')
        .onDelete('CASCADE')
        .index()

      table.string('key', 64).notNullable()
      table.string('name', 120).notNullable()
      table.string('type', 16).notNullable()
      table.json('default_value').nullable()
      table.string('description', 500).nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()

      table.unique(['product_id', 'key'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
