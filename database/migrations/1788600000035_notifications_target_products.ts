import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Announcements target customers of a product rather than a plan (licence
 * plan M5): the starter's SaaS tiers are gone, so "everyone on Pro" no longer
 * means anything.
 *
 * Existing rows are moved so that none reaches *more* people than before:
 *
 * - `plan` becomes `product` with no products chosen, which reaches nobody.
 *   A plan list cannot be translated into products, and an announcement that
 *   reaches nobody is a support ticket; one that reaches everybody is an
 *   incident (see `#notifications/audience`).
 * - `owners` loses its plan filter, which only ever narrowed it to tiers that
 *   now all resolve to one.
 */
export default class extends BaseSchema {
  async up() {
    this.defer(async (db) => {
      await db
        .from('notifications')
        .where('audience_type', 'plan')
        .update({ audience_type: 'product', audience: JSON.stringify({ productIds: [] }) })

      await db.from('notifications').where('audience_type', 'owners').update({ audience: null })
    })
  }

  async down() {}
}
