import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Orders (licence plan §4, M4) — one checkout, from the moment we ask the
 * provider for a checkout URL until the money has moved.
 *
 * Created **before** the customer pays, by us, with the email our own
 * backend sent. That row — not anything in the webhook payload — is what the
 * payment is later attributed to: the webhook carries only the order's
 * `public_id`, which we put into the checkout metadata ourselves. An email in
 * a webhook is something the payer typed; this one is something we recorded.
 *
 * `organization_id` is null until the order is fulfilled, when the customer
 * account is found by that email or created (§6, customer portal).
 */
export default class extends BaseSchema {
  protected tableName = 'orders'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('public_id', 32).notNullable().unique()

      table
        .integer('organization_id')
        .nullable()
        .references('id')
        .inTable('organizations')
        .onDelete('SET NULL')
        .index()

      table.string('email', 254).notNullable()
      table.string('status', 32).notNullable().defaultTo('pending')

      table.integer('total_cents').notNullable()
      table.string('currency', 3).notNullable()

      table.string('provider', 32).notNullable()
      table.string('provider_checkout_id', 128).nullable()
      table.string('provider_order_id', 128).nullable().unique()
      table.string('provider_subscription_id', 128).nullable().index()

      table.timestamp('paid_at', { useTz: true }).nullable()
      table.timestamp('fulfilled_at', { useTz: true }).nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
