import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'

import License from '#models/license'
import LicenseFlag from '#models/license_flag'
import LicenseActivation from '#models/license_activation'
import licensingConfig from '#config/licensing'
import { utcDay } from '#licensing/traffic'
import { findings, type LicenseUsage } from '#licensing/abuse'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'

/**
 * Collects the numbers `findings()` decides on, and turns findings into flags
 * (licence plan §9, M8).
 *
 * Only licenses with *something* to look at are examined: addresses seen
 * today or yesterday, new activations in the last day, or live development
 * sites. The rest cost nothing, however many there are.
 */
export class AbuseService {
  async detect(now: DateTime = DateTime.utc()): Promise<LicenseFlag[]> {
    const today = utcDay(now)
    const yesterday = utcDay(now.minus({ days: 1 }))

    const ipCounts = await this.distinctIpsByLicense([yesterday, today])
    const recentActivations = await this.activationsSince(now.minus({ hours: 24 }))
    const devSites = await this.liveDevSitesByLicense()

    const licenseIds = new Set<number>([
      ...ipCounts.keys(),
      ...recentActivations.keys(),
      ...devSites.keys(),
    ])

    const flagged: LicenseFlag[] = []

    for (const licenseId of licenseIds) {
      const license = await License.find(licenseId)

      if (!license || license.isRevoked) {
        continue
      }

      const live = await LicenseActivation.query()
        .where('license_id', license.id)
        .whereNull('deactivated_at')

      const usage: LicenseUsage = {
        maxActivations: license.maxActivations ?? null,
        liveActivations: live.filter((activation) => !activation.isDev).length,
        liveDevSites: devSites.get(licenseId) ?? 0,
        activationsLast24h: recentActivations.get(licenseId) ?? 0,
        distinctIpsByDay: Object.fromEntries(ipCounts.get(licenseId) ?? []),
      }

      for (const finding of findings(usage, today, licensingConfig.abuse)) {
        const flag = await this.raise(license, finding)

        if (flag) {
          flagged.push(flag)
        }
      }
    }

    return flagged
  }

  async open(limit = 50): Promise<LicenseFlag[]> {
    return LicenseFlag.query()
      .whereNull('resolved_at')
      .preload('license', (query) => query.preload('product').preload('organization'))
      .orderBy('id', 'desc')
      .limit(limit)
  }

  async openCount(): Promise<number> {
    const [row] = await LicenseFlag.query().whereNull('resolved_at').count('* as total')
    return Number(row.$extras.total)
  }

  async resolve(flag: LicenseFlag, staffId: number, note: string | null): Promise<LicenseFlag> {
    flag.resolvedAt = DateTime.utc()
    flag.resolvedByStaffId = staffId
    flag.resolutionNote = note?.trim().slice(0, 500) || null
    await flag.save()

    const license = await License.findOrFail(flag.licenseId)
    await licenses.record(
      license,
      'flag_resolved',
      { type: 'staff', id: staffId },
      {
        flag: flag.publicId,
        kind: flag.kind,
        note: flag.resolutionNote,
      }
    )

    return flag
  }

  /**
   * Address sightings past the retention window. Compared as `YYYY-MM-DD`
   * text, which orders the same on every database.
   */
  async prune(now: DateTime = DateTime.utc()): Promise<number> {
    const cutoff = utcDay(now.minus({ days: licensingConfig.abuse.ipRetentionDays }))
    const deleted = await db.from('license_ip_days').where('day', '<', cutoff).delete()
    return Number(Array.isArray(deleted) ? deleted.length : deleted)
  }

  /**
   * One flag per license, kind and day — whether or not an earlier one was
   * resolved. Resolving a flag at noon must not raise it again at one o'clock
   * from the same morning's numbers.
   */
  private async raise(license: License, finding: ReturnType<typeof findings>[number]) {
    const existing = await LicenseFlag.query()
      .where('license_id', license.id)
      .where('kind', finding.kind)
      .where('day', finding.day)
      .first()

    if (existing) {
      return null
    }

    let flag: LicenseFlag

    try {
      flag = await LicenseFlag.create({
        licenseId: license.id,
        kind: finding.kind,
        day: finding.day,
        details: { count: finding.count, allowance: finding.allowance },
      })
    } catch {
      return null // raised by a concurrent run; the unique index decides
    }

    await licenses.record(license, 'flagged', SYSTEM_ACTOR, {
      flag: flag.publicId,
      kind: finding.kind,
      count: finding.count,
      allowance: finding.allowance,
    })

    return flag
  }

  private async distinctIpsByLicense(days: string[]): Promise<Map<number, [string, number][]>> {
    const rows = await db
      .from('license_ip_days')
      .whereIn('day', days)
      .select('license_id', 'day')
      .count('* as total')
      .groupBy('license_id', 'day')

    const byLicense = new Map<number, [string, number][]>()

    for (const row of rows) {
      const entries = byLicense.get(Number(row.license_id)) ?? []
      entries.push([String(row.day), Number(row.total)])
      byLicense.set(Number(row.license_id), entries)
    }

    return byLicense
  }

  /**
   * New activations per license since `since`. Walks backwards by id, which
   * is creation order, and stops at the first older row — so the cost is the
   * last day's activations, not the table, and no timestamp is compared in
   * SQL (CONTRIBUTING).
   */
  private async activationsSince(since: DateTime): Promise<Map<number, number>> {
    const counts = new Map<number, number>()
    let beforeId: number | null = null

    for (;;) {
      const query = LicenseActivation.query().orderBy('id', 'desc').limit(500)
      if (beforeId !== null) query.where('id', '<', beforeId)
      const page = await query

      for (const activation of page) {
        if (activation.createdAt.toMillis() < since.toMillis()) {
          return counts
        }
        counts.set(activation.licenseId, (counts.get(activation.licenseId) ?? 0) + 1)
      }

      if (page.length < 500) {
        return counts
      }

      beforeId = page[page.length - 1].id
    }
  }

  private async liveDevSitesByLicense(): Promise<Map<number, number>> {
    const rows = await db
      .from('license_activations')
      .where('is_dev', true)
      .whereNull('deactivated_at')
      .select('license_id')
      .count('* as total')
      .groupBy('license_id')

    return new Map(
      rows
        .map((row) => [Number(row.license_id), Number(row.total)] as [number, number])
        .filter(([, total]) => total > licensingConfig.abuse.devSites)
    )
  }
}

export default new AbuseService()
