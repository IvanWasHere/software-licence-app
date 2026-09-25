import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * What an order bought (licence plan §4, M4). The price is copied from the
 * plan at checkout, so a later price change never rewrites history.
 *
 * One license is issued per unit of quantity, keyed on the item — the unique
 * `licenses.order_item_id` is what makes a redelivered webhook unable to
 * issue a second one.
 */
export default class extends BaseSchema {
  protected tableName = 'order_items'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()

      table
        .integer('order_id')
        .notNullable()
        .references('id')
        .inTable('orders')
        .onDelete('CASCADE')
        .index()

      table
        .integer('plan_id')
        .notNullable()
        .references('id')
        .inTable('plans')
        .onDelete('RESTRICT')

      table.integer('quantity').notNullable().defaultTo(1)
      table.integer('unit_price_cents').notNullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
