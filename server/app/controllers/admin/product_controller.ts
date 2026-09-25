import type { HttpContext } from '@adonisjs/core/http'

import catalog, { CatalogError } from '#catalog/catalog_service'
import audit, { AUDIT_ACTIONS } from '#audit/audit_service'
import { productValidator } from '#validators/catalog'
import { redirectBackWithErrors } from '#admin/form_errors'
import { ENTITLEMENT_TYPES } from '#catalog/entitlements'

/**
 * Products in the back-office (licence plan §8, M1).
 *
 * Support can read every screen here; `manageCatalog` (admin only) decides
 * whether the forms render and whether a write is accepted.
 */
export default class AdminProductController {
  async index({ view, staffBouncer }: HttpContext) {
    await staffBouncer.with('StaffPolicy').authorize('view')

    return view.render('pages/admin/products/index', {
      products: await catalog.products(),
      canManage: await staffBouncer.with('StaffPolicy').allows('manageCatalog'),
    })
  }

  async create({ view, staffBouncer }: HttpContext) {
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    return view.render('pages/admin/products/create', { product: null })
  }

  async store(ctx: HttpContext) {
    const { request, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    const payload = await request.validateUsing(productValidator)

    try {
      const product = await catalog.createProduct({
        ...payload,
        countDevSites: payload.countDevSites ?? false,
      })

      await audit.recordStaffAction(ctx, {
        action: AUDIT_ACTIONS.productCreated,
        subjectType: 'Product',
        subjectId: product.publicId,
        metadata: { slug: product.slug, name: product.name },
      })

      session.flash('success', `${product.name} created as a draft. Add its plans next.`)
      return response.redirect().toRoute('admin.products.show', { id: product.publicId })
    } catch (error) {
      if (error instanceof CatalogError) return redirectBackWithErrors(ctx, error.errors)
      throw error
    }
  }

  async show({ params, view, response, session, staffBouncer }: HttpContext) {
    await staffBouncer.with('StaffPolicy').authorize('view')

    const product = await catalog.findProduct(params.id)

    if (!product) {
      session.flash('error', 'No such product.')
      return response.redirect().toRoute('admin.products.index')
    }

    return view.render('pages/admin/products/show', {
      product,
      entitlementTypes: ENTITLEMENT_TYPES,
      canManage: await staffBouncer.with('StaffPolicy').allows('manageCatalog'),
    })
  }

  async update(ctx: HttpContext) {
    const { params, request, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    const product = await catalog.findProduct(params.id)

    if (!product) {
      session.flash('error', 'That product no longer exists.')
      return response.redirect().toRoute('admin.products.index')
    }

    const payload = await request.validateUsing(productValidator)
    const before = { slug: product.slug, status: product.status }

    try {
      await catalog.updateProduct(product, {
        ...payload,
        countDevSites: payload.countDevSites ?? false,
      })
    } catch (error) {
      if (error instanceof CatalogError) return redirectBackWithErrors(ctx, error.errors)
      throw error
    }

    await audit.recordStaffAction(ctx, {
      action: AUDIT_ACTIONS.productUpdated,
      subjectType: 'Product',
      subjectId: product.publicId,
      metadata: { before, after: { slug: product.slug, status: product.status } },
    })

    session.flash('success', `${product.name} saved.`)
    return response.redirect().toRoute('admin.products.show', { id: product.publicId })
  }
}
