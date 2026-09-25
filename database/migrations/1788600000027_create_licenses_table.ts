import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Licenses (licence plan §4, §5) — the thing a customer's software presents.
 *
 * The key is held twice, for two different jobs:
 *
 * - `key_hash` — SHA-256 of the key's random body, unique, the lookup column
 *   on every validate call. A dump of this column alone unlocks nothing.
 * - `key_encrypted` — the whole key under `APP_KEY`, so support and the
 *   customer portal can show it again. Customers lose keys; "we cannot tell
 *   you your own key" is not an answer a paying customer accepts.
 *
 * No salt, no slow hash, for the reason `api_keys` gives: 100 random bits is
 * not a password, and the hash sits on the hottest path we have.
 *
 * `status` only records what somebody decided (suspend, revoke). Whether a
 * license is *valid* is computed on every call from status, expiry,
 * subscription and activations (§5.1), so nothing has to flip a row on time.
 *
 * `max_activations` and the dates are copied from the plan at issue time:
 * editing a plan never silently changes what an existing customer bought.
 */
export default class extends BaseSchema {
  protected tableName = 'licenses'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('public_id', 32).notNullable().unique()

      table
        .integer('organization_id')
        .notNullable()
        .references('id')
        .inTable('organizations')
        .onDelete('CASCADE')
        .index()

      table
        .integer('product_id')
        .notNullable()
        .references('id')
        .inTable('products')
        .onDelete('RESTRICT')
        .index()

      table
        .integer('plan_id')
        .notNullable()
        .references('id')
        .inTable('plans')
        .onDelete('RESTRICT')
        .index()

      /**
       * The subscription whose payments keep a recurring license alive.
       * Null for one-time and manually issued licenses.
       */
      table
        .integer('subscription_id')
        .nullable()
        .references('id')
        .inTable('subscriptions')
        .onDelete('SET NULL')
        .index()

      /**
       * How the license came to exist. `order` licenses arrive in M4 with
       * the order that paid for them.
       */
      table.string('source', 16).notNullable()

      table.string('key_hash', 64).notNullable().unique()
      table.text('key_encrypted').notNullable()
      table.string('key_suffix', 4).notNullable()

      table.string('status', 16).notNullable().defaultTo('active')
      table.string('status_reason', 500).nullable()

      table.timestamp('expires_at', { useTz: true }).nullable()
      table.timestamp('updates_until', { useTz: true }).nullable()
      table.timestamp('support_until', { useTz: true }).nullable()

      table.integer('max_activations').nullable()
      table.json('entitlement_overrides').nullable()
      table.text('notes').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
