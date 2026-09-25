import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The starter's SaaS tiers are gone (licence plan M5): every account is on
 * the one `standard` tier. `planFor` already resolves any old key to it, so
 * this is tidiness rather than correctness — but a `plan_key` column that
 * still says `pro` is a question somebody will ask support.
 */
export default class extends BaseSchema {
  async up() {
    this.defer(async (db) => {
      await db.from('organizations').update({ plan_key: 'standard' })
      await db.from('subscriptions').whereNotNull('plan_id').update({ plan_key: 'license' })
    })
  }

  async down() {}
}
