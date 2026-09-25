import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * A license's own history (licence plan §4): issued, extended, suspended,
 * activations added and removed.
 *
 * Separate from `audit_logs` because it answers a different question.
 * The audit log is "what did staff do"; this is "what happened to this
 * license", including the parts nobody did by hand — a client activating,
 * a webhook extending. Append-only, like the audit log.
 */
export default class extends BaseSchema {
  protected tableName = 'license_events'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()

      table
        .integer('license_id')
        .notNullable()
        .references('id')
        .inTable('licenses')
        .onDelete('CASCADE')
        .index()

      table.string('type', 48).notNullable()
      table.string('actor_type', 16).notNullable()
      table.integer('actor_id').nullable()
      table.json('metadata').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
