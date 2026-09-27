import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Receipts (licence plan §13 Q6, M9): one numbered PDF per successful charge.
 *
 * Creem is the merchant of record, so the tax invoice is Creem's. This is
 * the *order receipt* from the company whose software was bought — the
 * document a customer files under the product's name — and it is issued for
 * every payment row, renewals included, not only for checkouts.
 *
 * The amount and currency are copied from the payment at issue time. A
 * receipt is a record of what was charged then; a later refund grows the
 * payment row and leaves the receipt as it was.
 */
export default class extends BaseSchema {
  protected tableName = 'receipts'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('public_id', 32).notNullable().unique()

      /**
       * `R-2026-000042`. Unique, and never reused: it is what the customer
       * quotes and what accounting files.
       */
      table.string('number', 32).notNullable().unique()

      table
        .integer('organization_id')
        .notNullable()
        .references('id')
        .inTable('organizations')
        .onDelete('CASCADE')
        .index()

      table
        .integer('payment_id')
        .notNullable()
        .references('id')
        .inTable('payments')
        .onDelete('CASCADE')
        .unique()

      table.string('storage_key', 1024).notNullable()
      table.integer('amount_cents').notNullable()
      table.string('currency', 8).notNullable()
      table.timestamp('issued_at', { useTz: true }).notNullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
