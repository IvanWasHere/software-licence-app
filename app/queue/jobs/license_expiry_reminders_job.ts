import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'

import User from '#models/user'
import License from '#models/license'
import LicenseEvent from '#models/license_event'
import mailer from '#mail/mailer_service'
import licensingConfig from '#config/licensing'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'
import LicenseExpiringNotification from '#mail/mails/license_expiring_notification'
import { reminderDue, renewsByItself, type ReminderSent } from '#licensing/expiry_reminders'
import type { JobHandler } from '#queue/contracts'

const DAY_MS = 86_400_000

/**
 * Emails the owner of every license that is about to expire and will not
 * renew by itself (licence plan §5.5, M8).
 *
 * Idempotent by construction: each reminder is recorded as a license event
 * carrying the threshold and the expiry it was about, and the decision reads
 * those back. Running twice in a day, or after a week of not running, sends
 * each reminder at most once.
 */
class LicenseExpiryRemindersJob implements JobHandler {
  readonly name = 'license_expiry_reminders'

  async handle() {
    const now = DateTime.utc()
    const horizonMs = Math.max(...licensingConfig.expiryReminderDays) * DAY_MS

    /**
     * Filtered in JavaScript rather than in SQL, like every timestamp
     * comparison here (CONTRIBUTING).
     */
    const withExpiry = await License.query()
      .where('status', 'active')
      .whereNotNull('expires_at')
      .preload('product')
      .preload('plan')
      .preload('subscription')
      .preload('organization')

    const candidates = withExpiry.filter((license) => {
      const remaining = license.expiresAt!.toMillis() - now.toMillis()
      return remaining > 0 && remaining <= horizonMs
    })

    let sent = 0

    for (const license of candidates) {
      if (renewsByItself(license.subscription ?? null)) {
        continue
      }

      const days = reminderDue({
        expiresAtMs: license.expiresAt!.toMillis(),
        nowMs: now.toMillis(),
        thresholds: licensingConfig.expiryReminderDays,
        sent: await this.sentFor(license),
      })

      if (days === null) {
        continue
      }

      const owner = await User.query()
        .where('organization_id', license.organizationId)
        .where('role', 'owner')
        .whereNull('deleted_at')
        .first()

      /**
       * Recorded before sending: a crash between the two loses one email,
       * the other order would send it again every day.
       */
      await licenses.record(license, 'expiry_reminder_sent', SYSTEM_ACTOR, {
        days,
        expires_at: license.expiresAt!.toUTC().toISO(),
        to: owner?.email ?? null,
      })

      if (!owner) {
        continue
      }

      const daysLeft = Math.max(
        1,
        Math.ceil((license.expiresAt!.toMillis() - now.toMillis()) / DAY_MS)
      )
      await mailer.send(
        new LicenseExpiringNotification(owner, license.organization, license, daysLeft)
      )
      sent++
    }

    logger.info({ candidates: candidates.length, sent }, 'license expiry reminders')
  }

  private async sentFor(license: License): Promise<ReminderSent[]> {
    const events = await LicenseEvent.query()
      .where('license_id', license.id)
      .where('type', 'expiry_reminder_sent')

    return events.map((event) => ({
      days: Number(event.metadata?.days),
      expiresAtMs: DateTime.fromISO(String(event.metadata?.expires_at)).toMillis(),
    }))
  }
}

export default new LicenseExpiryRemindersJob()
