import User from '#models/user'
import Organization from '#models/organization'
import apiKeys from '#api/api_key_service'
import registration from '#auth/registration_service'

/**
 * The system organisation and its integration keys (licence plan §6, M4).
 *
 * The system organisation is the one account that is us rather than a
 * customer. Its owner is an address on `.invalid`, a TLD that can never
 * receive mail, so nobody can reset a password for it and sign in as the
 * system account.
 */
export class IntegrationKeys {
  async systemOrganization(): Promise<Organization> {
    let organization = await Organization.query().where('is_system', true).first()

    if (!organization) {
      const created = await registration.register({
        email: 'integrations@system.invalid',
        fullName: 'Integrations',
        password: null,
        organizationName: 'System (integrations)',
      })

      organization = created.organization
      organization.isSystem = true
    }

    /**
     * The API is gated on a plan that includes it, and metered per month. The
     * system account is neither a customer nor on a plan, so both are lifted.
     */
    organization.planKey = 'business'
    organization.limitOverrides = {
      ...(organization.limitOverrides ?? {}),
      apiKeys: null,
      apiCallsPerMonth: null,
    }
    await organization.save()

    return organization
  }

  async create(name: string): Promise<{ organization: Organization; secret: string }> {
    const organization = await this.systemOrganization()
    const owner = await User.query()
      .where('organization_id', organization.id)
      .where('role', 'owner')
      .firstOrFail()

    const { secret } = await apiKeys.create(organization, owner, { name })

    return { organization, secret }
  }
}

export default new IntegrationKeys()
