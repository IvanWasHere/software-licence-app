import { randomUUID, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'

import Release from '#models/release'
import type Product from '#models/product'
import type License from '#models/license'
import storage from '#storage/disk_storage'
import { CatalogError } from '#catalog/catalog_service'
import { compareVersions, parseVersion } from '#catalog/semver'
import type { LicenseReason } from '#licensing/reasons'
import { evaluateLicense } from '#licensing/validation'

/**
 * Why a caller is not offered a release's download. The license reasons, plus
 * one only releases have: a perpetual license whose update window closed
 * before this build was published (licence plan §5.1, Q4) — still a valid
 * license, just not for *this* version.
 */
export type ReleaseDenial = LicenseReason | 'updates_expired' | 'license_required'

export type ReleaseChannel = 'stable' | 'beta'

/**
 * The largest build accepted. The bodyparser refuses anything bigger before it
 * reaches here; this is the rule a test and the admin screen can name.
 */
export const MAX_RELEASE_BYTES = 25 * 1024 * 1024

/**
 * How long the download link in a `releases/latest` answer works (licence
 * plan §9: "within 10 minutes"). WordPress fetches the package moments after
 * it asks, so this only has to outlive one update run.
 */
export const DOWNLOAD_LINK_TTL = '10 minutes'

export interface ReleaseUpload {
  tmpPath: string
  version: string
  channel: ReleaseChannel
  changelog?: string | null
  requires?: Record<string, string> | null
  testedUpTo?: string | null
  licenseRequired: boolean
}

/**
 * Whether one license may download one release, as a pure decision.
 *
 * `licenseCheck` is the ordinary validation answer; a license that fails it
 * gets nothing. A valid perpetual license gets every release published up to
 * the end of its update window, and keeps being able to download those —
 * it bought them — but not what came after.
 */
export function releaseAccess(input: {
  release: { licenseRequired: boolean; publishedAtMs: number | null }
  licenseCheck: { valid: true; reason: null } | { valid: false; reason: LicenseReason } | null
  updatesUntilMs: number | null
}): { allowed: true; reason: null } | { allowed: false; reason: ReleaseDenial } {
  if (!input.release.licenseRequired) {
    return { allowed: true, reason: null }
  }

  if (!input.licenseCheck) {
    return { allowed: false, reason: 'license_required' }
  }

  if (!input.licenseCheck.valid) {
    return { allowed: false, reason: input.licenseCheck.reason }
  }

  if (
    input.updatesUntilMs !== null &&
    input.release.publishedAtMs !== null &&
    input.release.publishedAtMs > input.updatesUntilMs
  ) {
    return { allowed: false, reason: 'updates_expired' }
  }

  return { allowed: true, reason: null }
}

/**
 * The newest release a channel offers. `beta` sees stable builds too — a
 * tester is offered 2.0.0 once it ships, not left on 2.0.0-rc.3. Yanked and
 * draft builds are never offered.
 */
export function pickLatest<T extends { version: string; channel: ReleaseChannel; status: string }>(
  releases: T[],
  channel: ReleaseChannel
): T | null {
  const candidates = releases.filter(
    (release) =>
      release.status === 'published' && (channel === 'beta' || release.channel === 'stable')
  )

  return candidates.reduce<T | null>(
    (best, release) =>
      !best || compareVersions(release.version, best.version) > 0 ? release : best,
    null
  )
}

/**
 * Releases (licence plan §4, §8, M7): upload a build, publish it, withdraw
 * it, and decide which one a caller is offered.
 *
 * The build is a zip on the private disk, under a key of our making. It is
 * outside the tenant file service on purpose: it belongs to no customer
 * account, counts against no quota, and is only ever handed out through a
 * signed, license-bound link.
 */
export class ReleaseService {
  async list(product: Product): Promise<Release[]> {
    const releases = await Release.query().where('product_id', product.id)
    return releases.sort((a, b) => compareVersions(b.version, a.version))
  }

  async find(product: Product, publicId: string): Promise<Release | null> {
    return Release.query().where('product_id', product.id).where('public_id', publicId).first()
  }

  async findPublic(publicId: string): Promise<Release | null> {
    return Release.query().where('public_id', publicId).preload('product').first()
  }

  async latest(product: Product, channel: ReleaseChannel): Promise<Release | null> {
    const published = await Release.query()
      .where('product_id', product.id)
      .where('status', 'published')

    return pickLatest(published, channel)
  }

  async upload(product: Product, input: ReleaseUpload): Promise<Release> {
    const version = input.version.trim().replace(/^v/, '')

    if (!parseVersion(version)) {
      throw new CatalogError({ version: 'Use a version like 1.4.0 or 2.0.0-beta.1.' })
    }

    const taken = await Release.query()
      .where('product_id', product.id)
      .where('version', version)
      .first()

    if (taken) {
      throw new CatalogError({
        version: `${version} already exists. Versions are permanent — ship ${version} as a new number.`,
      })
    }

    const { size, checksum } = await measure(input.tmpPath)

    if (size === 0) {
      throw new CatalogError({ file: 'That file is empty.' })
    }

    if (size > MAX_RELEASE_BYTES) {
      throw new CatalogError({ file: 'Builds are limited to 25 MB.' })
    }

    if (!(await isZip(input.tmpPath))) {
      throw new CatalogError({ file: 'A build must be a .zip file.' })
    }

    /**
     * Product first, then version, so a product's builds are one prefix; a
     * uuid for the name, never anything from the request.
     */
    const key = `releases/${product.publicId}/${version}/${randomUUID()}.zip`

    await storage.moveFromTmp({
      tmpPath: input.tmpPath,
      disk: 'private',
      key,
      contentType: 'application/zip',
    })

    try {
      return await Release.create({
        productId: product.id,
        version,
        channel: input.channel,
        status: 'draft',
        changelog: input.changelog?.trim() || null,
        requires: input.requires && Object.keys(input.requires).length ? input.requires : null,
        testedUpTo: input.testedUpTo?.trim() || null,
        licenseRequired: input.licenseRequired,
        fileKey: key,
        fileName: `${product.slug}-${version}.zip`,
        fileSize: size,
        checksum: checksum,
      })
    } catch (error) {
      await storage.delete({ disk: 'private', key }).catch(() => {})
      throw error
    }
  }

  /**
   * Offer a build. `published_at` is set the first time only: it is the date
   * update windows are measured against, and withdrawing and restoring a
   * build must not move it past somebody's window.
   */
  async publish(release: Release): Promise<Release> {
    if (release.isPublished) {
      return release
    }

    release.status = 'published'
    release.publishedAt ??= DateTime.utc()
    await release.save()

    return release
  }

  /**
   * Withdraw a published build. It stops being offered; it is not deleted,
   * because installs that already run it may need to reinstall it.
   */
  async yank(release: Release): Promise<Release> {
    if (!release.isPublished) {
      throw new CatalogError({ release: 'Only a published release can be withdrawn.' })
    }

    release.status = 'yanked'
    await release.save()

    return release
  }

  /**
   * Discard a draft, file and all. Anything that was ever published stays.
   */
  async discard(release: Release): Promise<void> {
    if (!release.isDraft) {
      throw new CatalogError({ release: 'Only a draft can be deleted. Withdraw it instead.' })
    }

    await db.transaction(async (trx) => {
      release.useTransaction(trx)
      await release.delete()
    })

    await storage.delete({ disk: 'private', key: release.fileKey }).catch(() => {})
  }

  /**
   * Whether this license may download this release.
   */
  access(
    release: Release,
    license: License | null,
    licenseCheck: Parameters<typeof releaseAccess>[0]['licenseCheck']
  ) {
    return releaseAccess({
      release: {
        licenseRequired: release.licenseRequired,
        publishedAtMs: release.publishedAt?.toMillis() ?? null,
      },
      licenseCheck,
      updatesUntilMs: license?.updatesUntil?.toMillis() ?? null,
    })
  }

  /**
   * `access` for a license already in hand — the download link and the
   * customer portal, where there is no key to check, only the row.
   */
  accessForLicense(release: Release, license: License | null) {
    const check = license
      ? evaluateLicense(
          license.toFacts(license.product.slug, license.subscription?.status ?? null),
          {
            productSlug: license.product.slug,
            nowMs: DateTime.utc().toMillis(),
          }
        )
      : null

    return this.access(release, license, check)
  }

  /**
   * A storage URL for the build itself, short-lived, forcing a download under
   * a readable name.
   */
  async fileUrl(release: Release): Promise<string> {
    return storage.urlFor({
      disk: 'private',
      key: release.fileKey,
      expiresIn: '5 minutes',
      downloadAs: release.fileName,
    })
  }
}

async function measure(path: string): Promise<{ size: number; checksum: string }> {
  const hash = createHash('sha256')
  let size = 0

  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    hash.update(chunk)
  }

  return { size, checksum: hash.digest('hex') }
}

/**
 * A zip starts with a local file header, `PK\x03\x04` — checked on the bytes,
 * never believed from the file name.
 */
async function isZip(path: string): Promise<boolean> {
  const handle = await open(path, 'r')

  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0)
    return bytesRead === 4 && buffer.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  } finally {
    await handle.close()
  }
}

export default new ReleaseService()
