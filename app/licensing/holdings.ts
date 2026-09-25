import { DateTime } from 'luxon'

import License from '#models/license'

/**
 * Which products each account holds a live license for (licence plan M5) —
 * what "customers of Invoice Pro" means when an announcement targets them.
 *
 * Live is the stored state a customer would recognise: not suspended or
 * revoked, and not past its expiry. It deliberately does not re-check the
 * subscription behind a license: an announcement is not an entitlement, and
 * somebody whose renewal failed yesterday still wants to hear that version
 * 2.5 is out.
 *
 * Decided in JavaScript rather than SQL for the reason CONTRIBUTING gives
 * about comparing timestamps (trap 2).
 */
export async function productIdsHeldBy(organizationIds?: number[]): Promise<Map<number, number[]>> {
  const query = License.query()
    .where('status', 'active')
    .select('organization_id', 'product_id', 'expires_at')

  if (organizationIds) {
    if (organizationIds.length === 0) {
      return new Map()
    }
    query.whereIn('organization_id', organizationIds)
  }

  const now = DateTime.utc().toMillis()
  const held = new Map<number, Set<number>>()

  for (const license of await query) {
    if (license.expiresAt && license.expiresAt.toMillis() <= now) {
      continue
    }

    const products = held.get(license.organizationId) ?? new Set<number>()
    products.add(license.productId)
    held.set(license.organizationId, products)
  }

  return new Map([...held.entries()].map(([id, products]) => [id, [...products]]))
}
