import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

import User from '#models/user'
import Organization from '#models/organization'
import registration from '#auth/registration_service'

export interface CustomerAccount {
  organization: Organization
  user: User

  /**
   * True when the account was made by this purchase. Its owner has no
   * password yet; the license email tells them how to set one.
   */
  created: boolean
}

/**
 * The customer account a paid order belongs to (licence plan §2 D1, M4).
 *
 * Found by the email **our** backend recorded on the order at checkout — never
 * by one in a webhook payload, which the payer controls. When nobody has that
 * address yet, an account is created with no password: the key goes to that
 * inbox, and only whoever reads it can set a password through the ordinary
 * reset flow and sign in. Nothing about the account is reachable before then.
 *
 * Buying for an address that already has an account adds the license to that
 * account. That is the intended behaviour — it is how a customer buys a second
 * product — and it grants the buyer nothing: they cannot see the account.
 */
export class CustomerAccounts {
  async forEmail(email: string, client: TransactionClientContract): Promise<CustomerAccount> {
    const normalised = email.trim().toLowerCase()

    const user = await User.query({ client })
      .where('email', normalised)
      .whereNull('deleted_at')
      .first()

    if (user) {
      const organization = await Organization.query({ client })
        .where('id', user.organizationId)
        .whereNull('deleted_at')
        .first()

      if (organization) {
        return { organization, user, created: false }
      }
    }

    const registered = await registration.register(
      { email: normalised, fullName: null, password: null },
      client
    )

    return { ...registered, created: true }
  }
}

export default new CustomerAccounts()
