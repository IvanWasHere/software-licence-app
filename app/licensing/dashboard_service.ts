import { DateTime } from 'luxon'

import License from '#models/license'
import LicenseActivation from '#models/license_activation'
import type Organization from '#models/organization'

/**
 * What the Overview screen says about an account's licenses (licence plan
 * M5). Bounded, indexed queries only — this runs on the screen a customer
 * lands on after signing in.
 */
export class LicensingDashboardService {
  async statsFor(organization: Organization) {
    const licenses = await License.query()
      .where('organization_id', organization.id)
      .preload('subscription')

    const now = DateTime.utc().toMillis()
    const soon = DateTime.utc().plus({ days: 30 }).toMillis()

    const usable = licenses.filter(
      (license) =>
        license.status === 'active' &&
        (!license.expiresAt || license.expiresAt.toMillis() > now) &&
        (!license.subscription || license.subscription.isEntitling)
    )

    const installs = usable.length
      ? await LicenseActivation.query()
          .whereIn(
            'license_id',
            usable.map((license) => license.id)
          )
          .whereNull('deactivated_at')
          .count('* as total')
      : [{ $extras: { total: 0 } }]

    return {
      total: licenses.length,
      active: usable.length,
      installs: Number(installs[0].$extras.total),
      expiringSoon: usable.filter(
        (license) =>
          license.expiresAt &&
          license.expiresAt.toMillis() <= soon &&
          !(license.subscription && !license.subscription.cancelAtPeriodEnd)
      ).length,
    }
  }

  async recent(organization: Organization, limit = 5) {
    return License.query()
      .where('organization_id', organization.id)
      .preload('product')
      .preload('plan')
      .orderBy('id', 'desc')
      .limit(limit)
  }
}

export default new LicensingDashboardService()
