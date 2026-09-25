import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Plans (licence plan §4) — what a customer actually buys: a price, a billing
 * rhythm, and the license that purchase produces.
 *
 * Not to be confused with the starter's SaaS tiers in `config/plans.ts`, which
 * describe what an *organisation* may do and go away in M4.
 *
 * `billing` is how money moves; `license_term` is how long the license lives.
 * They are separate because a one-time payment can buy either a perpetual
 * license or a fixed-length one, and `CatalogService` enforces which pairs are
 * meaningful.
 *
 * Plans are archived, never deleted: licenses point at them for as long as the
 * license exists.
 */
export default class extends BaseSchema {
  protected tableName = 'plans'

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

      table.string('slug', 64).notNullable()
      table.string('name', 120).notNullable()
      table.string('status', 16).notNullable().defaultTo('active')

      table.string('billing', 16).notNullable()
      table.integer('price_cents').notNullable()
      table.string('currency', 3).notNullable()

      table.string('license_term', 16).notNullable()
      table.integer('term_days').nullable()

      /**
       * For perpetual licenses: how long updates are included after purchase.
       * Null means for ever.
       */
      table.integer('updates_days').nullable()

      /**
       * Null means unlimited. Copied onto each license when it is issued, so
       * changing a plan never silently changes what existing customers bought.
       */
      table.integer('max_activations').nullable()

      /**
       * The payment provider's product for this plan. Unique so a webhook can
       * only ever resolve to one plan.
       */
      table.string('provider_product_id', 128).nullable().unique()

      table.boolean('is_public').notNullable().defaultTo(true)
      table.integer('sort_order').notNullable().defaultTo(0)

      table.json('entitlements').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()

      table.unique(['product_id', 'slug'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
