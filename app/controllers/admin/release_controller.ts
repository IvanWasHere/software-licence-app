import type { HttpContext } from '@adonisjs/core/http'

import catalog, { CatalogError } from '#catalog/catalog_service'
import releases from '#catalog/release_service'
import audit, { AUDIT_ACTIONS } from '#audit/audit_service'
import { redirectBackWithErrors } from '#admin/form_errors'
import { releaseValidator } from '#validators/catalog'

/**
 * A product's releases in the back-office (licence plan §8, M7): upload a
 * build as a draft, publish it, withdraw it. Publishing is what puts a build
 * in front of every installation that checks for updates, so each step is its
 * own action and each is audited.
 */
export default class AdminReleaseController {
  async store(ctx: HttpContext) {
    const { params, request, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    const product = await catalog.findProduct(params.id)

    if (!product) {
      session.flash('error', 'That product no longer exists.')
      return response.redirect().toRoute('admin.products.index')
    }

    const payload = await request.validateUsing(releaseValidator)
    const upload = request.file('file')

    if (!upload || !upload.tmpPath) {
      return redirectBackWithErrors(ctx, { file: 'Choose the .zip to upload.' })
    }

    const requires: Record<string, string> = {}
    if (payload.requiresWp) requires.wp = payload.requiresWp
    if (payload.requiresPhp) requires.php = payload.requiresPhp

    try {
      const release = await releases.upload(product, {
        tmpPath: upload.tmpPath,
        version: payload.version,
        channel: payload.channel,
        changelog: payload.changelog,
        requires,
        testedUpTo: payload.testedUpTo,
        licenseRequired: payload.licenseRequired ?? false,
      })

      await audit.recordStaffAction(ctx, {
        action: AUDIT_ACTIONS.releaseUploaded,
        subjectType: 'Release',
        subjectId: release.publicId,
        metadata: {
          product: product.slug,
          version: release.version,
          channel: release.channel,
          checksum_sha256: release.checksum,
        },
      })

      session.flash('success', `${release.version} uploaded as a draft. Publish it to offer it.`)
      return response.redirect().toRoute('admin.products.show', { id: product.publicId })
    } catch (error) {
      if (error instanceof CatalogError) return redirectBackWithErrors(ctx, error.errors)
      throw error
    }
  }

  async publish(ctx: HttpContext) {
    return this.transition(ctx, 'publish')
  }

  async yank(ctx: HttpContext) {
    return this.transition(ctx, 'yank')
  }

  async destroy(ctx: HttpContext) {
    return this.transition(ctx, 'discard')
  }

  private async transition(ctx: HttpContext, action: 'publish' | 'yank' | 'discard') {
    const { params, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    const product = await catalog.findProduct(params.id)
    const release = product ? await releases.find(product, params.releaseId) : null

    if (!product || !release) {
      session.flash('error', 'That release no longer exists.')
      return response.redirect().toRoute('admin.products.index')
    }

    try {
      if (action === 'publish') {
        await releases.publish(release)
      } else if (action === 'yank') {
        await releases.yank(release)
      } else {
        await releases.discard(release)
      }
    } catch (error) {
      if (error instanceof CatalogError) {
        session.flash('error', Object.values(error.errors).join(' '))
        return response.redirect().toRoute('admin.products.show', { id: product.publicId })
      }
      throw error
    }

    if (action !== 'discard') {
      await audit.recordStaffAction(ctx, {
        action: action === 'publish' ? AUDIT_ACTIONS.releasePublished : AUDIT_ACTIONS.releaseYanked,
        subjectType: 'Release',
        subjectId: release.publicId,
        metadata: { product: product.slug, version: release.version },
      })
    }

    session.flash(
      'success',
      action === 'publish'
        ? `${release.version} is published. Installations are offered it on their next update check.`
        : action === 'yank'
          ? `${release.version} is withdrawn. It is no longer offered.`
          : `Draft ${release.version} deleted.`
    )
    return response.redirect().toRoute('admin.products.show', { id: product.publicId })
  }
}
