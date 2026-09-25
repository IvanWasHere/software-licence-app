import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Activations (licence plan §5.2) — one installation of the software using a
 * license, identified by an `instance_id` the client generates once and
 * keeps.
 *
 * "At most one live activation per (license, instance)" would naturally be a
 * partial unique index, which portability rule 5 rules out. It is enforced
 * by `ActivationService` instead, inside a transaction that locks the license
 * row — the same lock that makes the activation limit safe. A deactivated
 * instance that comes back reuses its own row, so this table does not grow
 * every time somebody toggles a plugin.
 */
export default class extends BaseSchema {
  protected tableName = 'license_activations'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('public_id', 32).notNullable().unique()

      table
        .integer('license_id')
        .notNullable()
        .references('id')
        .inTable('licenses')
        .onDelete('CASCADE')

      table.string('instance_id', 64).notNullable()

      table.string('hostname', 255).nullable()
      table.string('site_url', 1024).nullable()
      table.string('label', 120).nullable()
      table.boolean('is_dev').notNullable().defaultTo(false)

      table.string('ip', 64).nullable()
      table.string('user_agent', 512).nullable()
      table.string('client_version', 32).nullable()

      table.timestamp('activated_at', { useTz: true }).notNullable()
      table.timestamp('last_seen_at', { useTz: true }).nullable()
      table.timestamp('deactivated_at', { useTz: true }).nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()

      table.index(['license_id', 'instance_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
