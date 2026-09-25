import { BaseTransformer } from '@adonisjs/core/transformers'

import type License from '#models/license'

/**
 * A customer's license on the organisation API (licence plan M5). Every field
 * named, so a new column can never widen the contract; the key itself is not
 * one of them — it is read in the account, never over an API key.
 */
export default class LicenseTransformer extends BaseTransformer<License> {
  toObject() {
    return {
      id: this.resource.publicId,
      product: this.resource.product.slug,
      plan: this.resource.plan.slug,
      key_suffix: this.resource.keySuffix,
      status: this.resource.status,
      expires_at: this.resource.expiresAt?.toUTC().toISO() ?? null,
      updates_until: this.resource.updatesUntil?.toUTC().toISO() ?? null,
      max_activations: this.resource.maxActivations ?? null,
      created_at: this.resource.createdAt.toUTC().toISO(),
    }
  }
}
