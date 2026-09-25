import type Notification from '#models/notification'

/**
 * Who an announcement reaches (plan §20.3).
 *
 * **This is the only place in the application where a decision is made
 * without an `organization_id` filter.** Every other table is tenant-owned
 * and §5.4's rule holds; here, crossing tenants *is* the feature — one row
 * reaches every account holding a license for a product. Which means a bug in this function
 * shows one customer another customer's announcement, and there is nothing
 * else downstream that would catch it.
 *
 * So it is deliberately one small pure function rather than a query, a scope
 * and a template condition that could drift apart:
 *
 * - **Pure.** No database, no network. Everything it needs — the role, the id
 *   and the products the account holds — is handed to it by the caller, which
 *   loads them once (`#licensing/holdings`).
 * - **Exhaustive.** The switch covers every `audience_type`, and the type is
 *   a closed union from `schema_rules`, so adding a fifth kind of audience
 *   without handling it is a compile error.
 * - **Closed by default.** Anything unrecognised returns false. An
 *   announcement that reaches nobody is a support ticket; one that reaches
 *   everybody is an incident.
 */

/**
 * The parts of a viewer that matter. A structural type rather than the models
 * themselves, so the predicate can be tested against plain objects — which is
 * what makes covering every combination cheap enough to actually do.
 */
export interface AudienceViewer {
  id: number
  role: 'owner' | 'member'

  /**
   * Products the viewer's account holds a live license for.
   */
  productIds: readonly number[]
}

export function appliesTo(
  notification: Pick<Notification, 'audienceType' | 'audience'>,
  viewer: AudienceViewer
): boolean {
  const audience = notification.audience ?? {}

  switch (notification.audienceType) {
    case 'all':
      return true

    /**
     * Customers of a product (licence plan M5): everybody in an account that
     * holds a live license for one of these products, owners and members
     * alike. An empty list matches nobody rather than everybody — see the
     * note on being closed by default.
     */
    case 'product':
      return (audience.productIds ?? []).some((id) => viewer.productIds.includes(id))

    /**
     * Owners only, optionally narrowed to customers of some products. The
     * list being empty here means "every owner", because the *type* has
     * already narrowed the audience — unlike `product`, where an empty list
     * would mean the author picked nothing.
     */
    case 'owners': {
      if (viewer.role !== 'owner') {
        return false
      }

      const productIds = audience.productIds ?? []
      return productIds.length === 0 || productIds.some((id) => viewer.productIds.includes(id))
    }

    /**
     * Named people. Internal ids, never public ones: they do not leave the
     * process, and the admin screen resolves people through the existing user
     * search.
     */
    case 'users':
      return (audience.userIds ?? []).includes(viewer.id)

    default:
      return false
  }
}

/**
 * A one-line description of who a notification reaches, for the back-office
 * list. Written as a sentence rather than as the raw enum, because "owners"
 * and "owners on Pro" are different answers to the question somebody is
 * actually asking.
 */
export function describeAudience(
  notification: Pick<Notification, 'audienceType' | 'audience'>,
  productNames: ReadonlyMap<number, string> = new Map()
): string {
  const products = (notification.audience?.productIds ?? []).map(
    (id) => productNames.get(id) ?? `product #${id}`
  )
  const userIds = notification.audience?.userIds ?? []

  switch (notification.audienceType) {
    case 'all':
      return 'Everyone'

    case 'product':
      return products.length ? `Customers of ${products.join(', ')}` : 'Nobody — no product chosen'

    case 'owners':
      return products.length ? `Owners with ${products.join(', ')}` : 'All account owners'

    case 'users':
      return userIds.length === 1
        ? '1 named person'
        : `${userIds.length} named ${userIds.length === 1 ? 'person' : 'people'}`

    default:
      return 'Nobody'
  }
}
