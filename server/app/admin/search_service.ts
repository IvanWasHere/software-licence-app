import User from '#models/user'
import License from '#models/license'
import Organization from '#models/organization'
import { licenseKeyHash } from '#licensing/keys'

/**
 * Finding a customer from whatever the ticket gave you (plan §12).
 *
 * A support agent has an email, half a workspace name, or a `public_id` a
 * customer pasted from a URL — so one box takes all three rather than three
 * boxes that each work for one.
 */
export class AdminSearchService {
  /**
   * Case-insensitivity is done by lowercasing both sides rather than with
   * `ILIKE` or `citext`, which portability rule 5 rules out. Emails are
   * already stored lowercased; names are not, so those are filtered in
   * memory over a bounded result set.
   */
  async organizations(term: string, limit = 25): Promise<Organization[]> {
    const needle = term.trim().toLowerCase()

    if (!needle) {
      return Organization.query().whereNull('deleted_at').orderBy('id', 'desc').limit(limit)
    }

    /**
     * An exact `public_id` short-circuits: it is the one identifier that is
     * unambiguous, and it is what a customer pastes out of a URL.
     */
    if (needle.startsWith('org_')) {
      const exact = await Organization.query().where('public_id', needle).first()

      if (exact) {
        return [exact]
      }
    }

    /**
     * An email finds the workspace through its member, which is how a
     * support ticket usually identifies one.
     */
    const byEmail = await User.query()
      .where('email', needle)
      .whereNull('deleted_at')
      .select('organization_id')

    const candidates = await Organization.query()
      .whereNull('deleted_at')
      .orderBy('id', 'desc')
      .limit(500)

    const matched = candidates.filter(
      (organization) =>
        organization.name.toLowerCase().includes(needle) ||
        organization.slug.includes(needle) ||
        organization.publicId === needle ||
        byEmail.some((user) => user.organizationId === organization.id)
    )

    return matched.slice(0, limit)
  }

  async users(term: string, limit = 25): Promise<User[]> {
    const needle = term.trim().toLowerCase()

    const query = User.query().preload('organization').orderBy('id', 'desc')

    if (!needle) {
      return query.limit(limit)
    }

    if (needle.startsWith('usr_')) {
      const exact = await User.query().where('public_id', needle).preload('organization').first()

      if (exact) {
        return [exact]
      }
    }

    /**
     * Soft-deleted users are included on purpose: "we removed them and now
     * they cannot get back in" is a support question about somebody who is
     * deleted.
     */
    const candidates = await query.limit(500)

    return candidates
      .filter(
        (user) =>
          user.email.includes(needle) ||
          (user.fullName ?? '').toLowerCase().includes(needle) ||
          user.publicId === needle
      )
      .slice(0, limit)
  }

  /**
   * Licenses from whatever the ticket gave you (licence plan §8): the key
   * itself, the last four characters of it, a license or organisation id, or
   * a customer's email.
   *
   * A pasted key is matched by hash, exactly as the license API matches it —
   * so "it says invalid" can be checked by pasting the same string here.
   */
  async licenses(
    term: string,
    filters: { status?: License['status'] | null; productId?: number | null } = {},
    limit = 50
  ): Promise<License[]> {
    const needle = term.trim()
    const query = License.query()
      .preload('product')
      .preload('plan')
      .preload('organization')
      .orderBy('id', 'desc')
      .limit(limit)

    if (filters.status) {
      query.where('status', filters.status)
    }

    if (filters.productId) {
      query.where('product_id', filters.productId)
    }

    if (!needle) {
      return query
    }

    const lower = needle.toLowerCase()

    if (lower.startsWith('lic_')) {
      return query.where('public_id', lower)
    }

    const hash = needle.length >= 20 ? licenseKeyHash(needle) : null

    if (hash) {
      return query.where('key_hash', hash)
    }

    if (/^[0-9a-z]{4}$/i.test(needle)) {
      return query.where('key_suffix', needle.toUpperCase())
    }

    const organization = await this.customer(needle)

    return organization ? query.where('organization_id', organization.id) : []
  }

  /**
   * The customer account a staff member means, from an organisation id or the
   * email of anybody in it. Exact matches only: issuing a license to the
   * wrong customer because a name half-matched is the mistake to prevent.
   */
  async customer(term: string): Promise<Organization | null> {
    const needle = term.trim().toLowerCase()

    if (needle.startsWith('org_')) {
      return Organization.query().where('public_id', needle).whereNull('deleted_at').first()
    }

    if (!needle.includes('@')) {
      return null
    }

    const user = await User.query().where('email', needle).whereNull('deleted_at').first()

    if (!user) {
      return null
    }

    return Organization.query().where('id', user.organizationId).whereNull('deleted_at').first()
  }
}

export default new AdminSearchService()
