import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The starter's demo domain (lists and todos) is gone (licence plan M5).
 *
 * Its create migrations stay where they are — Lucid records a migration by its
 * path, so deleting them would make every existing database look corrupt
 * (CONTRIBUTING, trap 12). The tables are dropped here instead, which is what
 * `docs/modules.md` prescribes for an install that already has them.
 *
 * `down` does not recreate them: the module that owned them no longer exists,
 * so a table with nothing to read it would only be clutter. The two create
 * migrations drop with `dropTableIfExists` for the same reason, so a full
 * rollback (which the test suite does after every run) passes over tables
 * this migration already removed.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.dropTableIfExists('todos')
    this.schema.dropTableIfExists('todo_lists')
  }

  async down() {}
}
