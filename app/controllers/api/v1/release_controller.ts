import { DateTime } from 'luxon'
import router from '@adonisjs/core/services/router'
import type { HttpContext } from '@adonisjs/core/http'

import env from '#start/env'
import Product from '#models/product'
import License from '#models/license'
import type Release from '#models/release'
import licenses from '#licensing/license_service'
import activations from '#licensing/activation_service'
import releases, { DOWNLOAD_LINK_TTL } from '#catalog/release_service'
import { ApiException, ApiNotFoundException } from '#api/errors'
import { latestReleaseValidator } from '#validators/license_api'
import { envelope, licenseSummary, withSignature } from '#licensing/api_payload'

/**
 * The purpose a download link is signed for, so no other signed URL in the
 * application can be replayed as one.
 */
const DOWNLOAD_PURPOSE = 'release_download'

/**
 * Updates (licence plan §6, M7).
 *
 * `latest` says what the newest build is and, when the caller's license
 * covers it, hands over a download link that works for ten minutes and only
 * for that license and that build. The release is described either way, so
 * an installation whose updates ran out can still show "2.1 is available —
 * renew to get it".
 */
export default class ReleaseApiController {
  async latest(ctx: HttpContext) {
    const { params, request, response } = ctx
    const query = await request.validateUsing(latestReleaseValidator, { data: request.qs() })

    const product = await Product.query()
      .where('slug', String(params.slug))
      .whereNot('status', 'draft')
      .first()

    if (!product) {
      throw new ApiNotFoundException()
    }

    const release = await releases.latest(product, query.channel ?? 'stable')

    const check = query.license_key
      ? await licenses.check(query.license_key, product.slug, query.instance_id)
      : null

    /**
     * An update check is as good a sign of life as a validation.
     */
    if (check?.result.valid && check.activation) {
      await activations.touch(check.activation)
    }

    const access = release
      ? releases.access(release, check?.license ?? null, check?.result ?? null)
      : null
    const license =
      check?.license && check.license.product.slug === product.slug ? check.license : null

    return response.ok(
      withSignature({
        release: release ? this.describe(release) : null,
        update_allowed: Boolean(access?.allowed),
        reason: access && !access.allowed ? access.reason : (check?.result.reason ?? null),
        download: release && access?.allowed ? this.downloadLink(release, license) : null,
        license: license ? licenseSummary(license, await activations.usage(license)) : null,
        ...envelope({
          requestId: String(response.getHeader('x-request-id') ?? ''),
          product: product.slug,
          instanceId: query.instance_id,
          nonce: query.nonce,
        }),
      })
    )
  }

  /**
   * The link from `latest`. The signature is the credential; the license is
   * checked again anyway, because ten minutes is long enough for a refund to
   * land.
   */
  async download({ params, request, response }: HttpContext) {
    if (!request.hasValidSignature(DOWNLOAD_PURPOSE)) {
      throw new ApiException('forbidden', 'This download link is invalid or has expired.', 403)
    }

    const release = await releases.findPublic(String(params.id))

    if (!release || release.isDraft) {
      throw new ApiNotFoundException()
    }

    const licenseId = request.qs().license
    const license = licenseId
      ? await License.query()
          .where('public_id', String(licenseId))
          .where('product_id', release.productId)
          .preload('product')
          .preload('plan')
          .preload('subscription')
          .first()
      : null

    const access = releases.accessForLicense(release, license)

    if (!access.allowed) {
      throw new ApiException('forbidden', 'This license does not include this release.', 403, {
        reason: access.reason,
      })
    }

    /**
     * Without this query, not with it: query strings are forwarded on
     * redirect by default (`config/app.ts`), and this link's own signature
     * appended to the storage URL would break that URL's signature.
     */
    return response
      .redirect()
      .withQs(false)
      .toPath(await releases.fileUrl(release))
  }

  private describe(release: Release) {
    return {
      id: release.publicId,
      version: release.version,
      channel: release.channel,
      changelog: release.changelog,
      requires: release.requires ?? {},
      tested_up_to: release.testedUpTo,
      published_at: release.publishedAt?.toUTC().toISO() ?? null,
      file_name: release.fileName,
      file_size: release.fileSize,
      checksum_sha256: release.checksum,
    }
  }

  private downloadLink(release: Release, license: License | null) {
    const path = router.urlBuilder.signedUrlFor(
      'license_api.release_download',
      { id: release.publicId },
      {
        expiresIn: DOWNLOAD_LINK_TTL,
        purpose: DOWNLOAD_PURPOSE,
        qs: license ? { license: license.publicId } : {},
      }
    )

    return {
      url: `${env.get('APP_URL')}${path}`,
      expires_at: DateTime.utc().plus({ minutes: 10 }).toISO(),
    }
  }
}
