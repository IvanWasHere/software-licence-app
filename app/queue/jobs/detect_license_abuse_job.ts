import logger from '@adonisjs/core/services/logger'

import StaffUser from '#models/staff_user'
import mailer from '#mail/mailer_service'
import abuse from '#licensing/abuse_service'
import traffic from '#licensing/traffic'
import LicenseAbuseNotification from '#mail/mails/license_abuse_notification'
import type { JobHandler } from '#queue/contracts'

/**
 * Looks for keys that are being shared (licence plan §9, M8): too many
 * addresses in a day, too many new installations, too many dev sites.
 *
 * It **flags and tells admins**. It never suspends or revokes — a busy agency
 * and a leaked key look alike to a counter, and the difference is a human
 * call.
 */
class DetectLicenseAbuseJob implements JobHandler {
  readonly name = 'detect_license_abuse'

  async handle() {
    /**
     * The worker is a different process from the web servers; what this one
     * has buffered is little, but written first all the same.
     */
    await traffic.flush()

    const flagged = await abuse.detect()
    const pruned = await abuse.prune()

    logger.info({ flagged: flagged.length, pruned }, 'license abuse check')

    if (!flagged.length) {
      return
    }

    const admins = await StaffUser.query().where('role', 'admin').whereNull('disabled_at')

    for (const flag of flagged) {
      await flag.load('license', (query) => query.preload('product').preload('organization'))
    }

    for (const admin of admins) {
      await mailer.send(new LicenseAbuseNotification(admin.email, flagged))
    }
  }
}

export default new DetectLicenseAbuseJob()
