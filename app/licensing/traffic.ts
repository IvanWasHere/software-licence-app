import { createHmac } from 'node:crypto'
import { DateTime } from 'luxon'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'

import env from '#start/env'

export type LicenseApiEndpoint = 'validate' | 'activate' | 'deactivate' | 'latest'

/**
 * How often buffered counts are written. A crash loses at most this much
 * traffic *counting* — never a license decision.
 */
const FLUSH_INTERVAL_MS = 60_000

/**
 * The most distinct (license, address) pairs remembered between flushes.
 * Past it the buffer is flushed early, so a flood of addresses costs writes,
 * not memory.
 */
const MAX_PENDING_SIGHTINGS = 50_000

export function utcDay(at: DateTime = DateTime.utc()): string {
  return at.toUTC().toFormat('yyyy-LL-dd')
}

/**
 * License API traffic, counted without slowing the API (licence plan §8, M8).
 *
 * The validate path must stay a couple of reads. So a request only bumps a
 * counter in memory; the counts and the address sightings are written about
 * once a minute, and on shutdown. Each process keeps its own buffer and adds
 * to the same rows, so replicas need no coordination.
 *
 * What it is for: the dashboard's traffic numbers, and the abuse job's
 * "distinct addresses per day".
 */
export class LicenseTraffic {
  #counts = new Map<
    string,
    {
      day: string
      productId: number
      endpoint: LicenseApiEndpoint
      requests: number
      refused: number
    }
  >()
  #sightings = new Map<string, { day: string; licenseId: number; ipHash: string }>()
  #recent = new Set<string>()
  #recentDay = ''
  #timer: NodeJS.Timeout | null = null
  #flushing: Promise<void> | null = null

  /**
   * One request to a license endpoint for a known product. `refused` is an
   * answer that said no — an invalid key, a full license, no update.
   */
  hit(productId: number, endpoint: LicenseApiEndpoint, refused: boolean): void {
    const day = utcDay()
    const key = `${day}|${productId}|${endpoint}`
    const entry = this.#counts.get(key) ?? { day, productId, endpoint, requests: 0, refused: 0 }

    entry.requests++
    if (refused) entry.refused++

    this.#counts.set(key, entry)
    this.#schedule()
  }

  /**
   * A license was used from an address. Stored as an HMAC under the app key:
   * countable, not reversible, and not comparable across deployments.
   */
  saw(licenseId: number, ip: string): void {
    const day = utcDay()

    if (day !== this.#recentDay) {
      this.#recent.clear()
      this.#recentDay = day
    }

    const ipHash = createHmac('sha256', env.get('APP_KEY').release()).update(ip).digest('hex')
    const key = `${licenseId}|${ipHash}`

    /**
     * Already written today by this process: a plugin validating every hour
     * from the same server costs one row a day, not twenty-four.
     */
    if (this.#recent.has(key)) {
      return
    }

    this.#recent.add(key)
    this.#sightings.set(`${day}|${key}`, { day, licenseId, ipHash })

    if (this.#sightings.size >= MAX_PENDING_SIGHTINGS) {
      void this.flush()
    }

    this.#schedule()
  }

  /**
   * Write what is buffered. Safe to call at any time and concurrently; a
   * failure is logged and the numbers are put back for the next attempt.
   */
  async flush(): Promise<void> {
    if (this.#flushing) {
      await this.#flushing
    }

    const counts = [...this.#counts.values()]
    const sightings = [...this.#sightings.values()]
    this.#counts.clear()
    this.#sightings.clear()

    if (!counts.length && !sightings.length) {
      return
    }

    this.#flushing = this.#write(counts, sightings)
      .catch((error) => {
        logger.error({ err: error }, 'could not record license API traffic')

        for (const entry of counts) {
          const key = `${entry.day}|${entry.productId}|${entry.endpoint}`
          const pending = this.#counts.get(key)
          this.#counts.set(
            key,
            pending
              ? {
                  ...pending,
                  requests: pending.requests + entry.requests,
                  refused: pending.refused + entry.refused,
                }
              : entry
          )
        }
      })
      .finally(() => {
        this.#flushing = null
      })

    await this.#flushing
  }

  /** Forget everything buffered, for tests. */
  reset(): void {
    this.#counts.clear()
    this.#sightings.clear()
    this.#recent.clear()
  }

  async #write(
    counts: {
      day: string
      productId: number
      endpoint: LicenseApiEndpoint
      requests: number
      refused: number
    }[],
    sightings: { day: string; licenseId: number; ipHash: string }[]
  ): Promise<void> {
    for (const entry of counts) {
      const where = { day: entry.day, product_id: entry.productId, endpoint: entry.endpoint }
      const increment = { requests: entry.requests, refused: entry.refused }

      const updated = await db.from('license_api_days').where(where).increment(increment)

      if (affected(updated) > 0) {
        continue
      }

      try {
        await db.table('license_api_days').insert({ ...where, ...increment })
      } catch {
        /**
         * Another process inserted the row between our update and insert.
         * Its row exists now, so the increment lands.
         */
        await db.from('license_api_days').where(where).increment(increment)
      }
    }

    for (const sighting of sightings) {
      try {
        await db.table('license_ip_days').insert({
          license_id: sighting.licenseId,
          day: sighting.day,
          ip_hash: sighting.ipHash,
        })
      } catch {
        /**
         * Already recorded — by another process, or by this one before a
         * restart. The unique index is what makes a sighting count once.
         */
      }
    }
  }

  #schedule(): void {
    if (this.#timer) {
      return
    }

    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, FLUSH_INTERVAL_MS)

    this.#timer.unref()
  }
}

/**
 * Knex reports affected rows as a number on SQLite and Postgres, and as an
 * array on some drivers; either way, "did anything change".
 */
function affected(result: unknown): number {
  if (typeof result === 'number') return result
  if (Array.isArray(result)) return result.length
  return 0
}

const traffic = new LicenseTraffic()

/**
 * Written out when the process stops, so a deploy does not drop the last
 * minute's numbers.
 */
app.terminating(async () => {
  await traffic.flush()
})

export default traffic
