import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * License API traffic and abuse flags (licence plan §8, §9, M8).
 *
 * - `license_api_days` — requests per product, endpoint and day. Counted in
 *   memory and flushed about once a minute, so the validate path gains no
 *   write per request. Only known products are counted: a counter keyed by
 *   whatever slug a caller sends would be a free write endpoint.
 * - `license_ip_days` — which addresses used a license on a day, as an HMAC,
 *   never the address itself: enough to count distinct ones, useless for
 *   anything else. Pruned after 30 days by the abuse job.
 * - `license_flags` — what the abuse job found, for staff to look at.
 *   Nothing is ever revoked automatically (§9). `day` makes a finding
 *   once-per-day: resolving a flag does not raise it again an hour later from
 *   the same day's numbers.
 *
 * `day` is `YYYY-MM-DD` in UTC, as a string: compared and grouped as text,
 * identically on SQLite and Postgres.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('license_api_days', (table) => {
      table.increments('id').notNullable()
      table.string('day', 10).notNullable()
      table
        .integer('product_id')
        .notNullable()
        .references('id')
        .inTable('products')
        .onDelete('CASCADE')
      table.string('endpoint', 16).notNullable()
      table.integer('requests').notNullable().defaultTo(0)
      table.integer('refused').notNullable().defaultTo(0)

      table.unique(['day', 'product_id', 'endpoint'])
      table.index(['day'])
    })

    this.schema.createTable('license_ip_days', (table) => {
      table.increments('id').notNullable()
      table
        .integer('license_id')
        .notNullable()
        .references('id')
        .inTable('licenses')
        .onDelete('CASCADE')
      table.string('day', 10).notNullable()
      table.string('ip_hash', 64).notNullable()

      table.unique(['license_id', 'day', 'ip_hash'])
      table.index(['day'])
    })

    this.schema.createTable('license_flags', (table) => {
      table.increments('id').notNullable()
      table.string('public_id', 32).notNullable().unique()
      table
        .integer('license_id')
        .notNullable()
        .references('id')
        .inTable('licenses')
        .onDelete('CASCADE')
        .index()
      table.string('kind', 32).notNullable()
      table.string('day', 10).notNullable()
      table.json('details').nullable()

      table.timestamp('resolved_at', { useTz: true }).nullable()
      table
        .integer('resolved_by_staff_id')
        .nullable()
        .references('id')
        .inTable('staff_users')
        .onDelete('SET NULL')
      table.string('resolution_note', 500).nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()

      table.unique(['license_id', 'kind', 'day'])
    })
  }

  async down() {
    this.schema.dropTableIfExists('license_flags')
    this.schema.dropTableIfExists('license_ip_days')
    this.schema.dropTableIfExists('license_api_days')
  }
}
