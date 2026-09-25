import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Connect the starter's billing tables to the catalog and licenses (licence
 * plan §4, M4). Additive only (portability rule 4).
 *
 * The new columns carry an index but no foreign key: adding a constrained
 * column to an existing table is a table rebuild on SQLite, and every one of
 * these is only ever written by a service that has just loaded the row it
 * points at.
 *
 * - `licenses.order_item_id` is **unique**: one item, one license. A NULL
 *   does not collide with another NULL on either engine, so manual licenses
 *   are unaffected.
 * - `subscriptions.plan_id` marks a subscription that keeps a license alive,
 *   as opposed to one of the starter's SaaS tiers (removed in M5).
 * - `organizations.is_system` marks the one account that is us — the owner of
 *   the integration API keys our own website uses.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('licenses', (table) => {
      table.integer('order_id').nullable().index()
      table.integer('order_item_id').nullable().unique()
    })

    this.schema.alterTable('subscriptions', (table) => {
      table.integer('plan_id').nullable().index()
    })

    this.schema.alterTable('organizations', (table) => {
      table.boolean('is_system').notNullable().defaultTo(false)
    })
  }

  async down() {
    this.schema.alterTable('organizations', (table) => {
      table.dropColumn('is_system')
    })

    this.schema.alterTable('subscriptions', (table) => {
      table.dropColumn('plan_id')
    })

    this.schema.alterTable('licenses', (table) => {
      table.dropUnique(['order_item_id'])
      table.dropIndex(['order_id'])
      table.dropColumn('order_item_id')
      table.dropColumn('order_id')
    })
  }
}
