import type { HttpContext } from '@adonisjs/core/http'

import catalog, { CatalogError } from '#catalog/catalog_service'
import audit, { AUDIT_ACTIONS } from '#audit/audit_service'
import { redirectBackWithErrors } from '#admin/form_errors'
import { createEntitlementValidator, updateEntitlementValidator } from '#validators/catalog'

/**
 * A product's entitlement definitions (licence plan §8, M1). Every write here
 * changes what existing customers receive on their next validation, which is
 * why each one is audited with the key it touched.
 */
export default class AdminEntitlementController {
  async store(ctx: HttpContext) {
    const { params, request, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    const product = await catalog.findProduct(params.id)

    if (!product) {
      session.flash('error', 'That product no longer exists.')
      return response.redirect().toRoute('admin.products.index')
    }

    const payload = await request.validateUsing(createEntitlementValidator)

    try {
      const entitlement = await catalog.createEntitlement(product, payload)

      await audit.recordStaffAction(ctx, {
        action: AUDIT_ACTIONS.entitlementCreated,
        subjectType: 'Entitlement',
        subjectId: entitlement.publicId,
        metadata: { product: product.slug, key: entitlement.key, type: entitlement.type },
      })

      session.flash(
        'success',
        `${entitlement.key} added. Set its value on each plan that grants it.`
      )
      return response.redirect().toRoute('admin.products.show', { id: product.publicId })
    } catch (error) {
      if (error instanceof CatalogError) return redirectBackWithErrors(ctx, error.errors)
      throw error
    }
  }

  async update(ctx: HttpContext) {
    const { params, request, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    const product = await catalog.findProduct(params.id)
    const entitlement = product
      ? await catalog.findEntitlement(product, params.entitlementId)
      : null

    if (!product || !entitlement) {
      session.flash('error', 'That entitlement no longer exists.')
      return response.redirect().toRoute('admin.products.index')
    }

    const payload = await request.validateUsing(updateEntitlementValidator)
    const before = { defaultValue: entitlement.defaultValue }

    try {
      await catalog.updateEntitlement(entitlement, payload)
    } catch (error) {
      if (error instanceof CatalogError) return redirectBackWithErrors(ctx, error.errors)
      throw error
    }

    await audit.recordStaffAction(ctx, {
      action: AUDIT_ACTIONS.entitlementUpdated,
      subjectType: 'Entitlement',
      subjectId: entitlement.publicId,
      metadata: {
        product: product.slug,
        key: entitlement.key,
        before,
        after: { defaultValue: entitlement.defaultValue },
      },
    })

    session.flash('success', `${entitlement.key} saved.`)
    return response.redirect().toRoute('admin.products.show', { id: product.publicId })
  }

  async destroy(ctx: HttpContext) {
    const { params, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    const product = await catalog.findProduct(params.id)
    const entitlement = product
      ? await catalog.findEntitlement(product, params.entitlementId)
      : null

    if (!product || !entitlement) {
      session.flash('error', 'That entitlement no longer exists.')
      return response.redirect().toRoute('admin.products.index')
    }

    await catalog.deleteEntitlement(entitlement)

    await audit.recordStaffAction(ctx, {
      action: AUDIT_ACTIONS.entitlementDeleted,
      subjectType: 'Entitlement',
      subjectId: entitlement.publicId,
      metadata: { product: product.slug, key: entitlement.key },
    })

    session.flash(
      'success',
      `${entitlement.key} deleted. It disappears from every license's next validation.`
    )
    return response.redirect().toRoute('admin.products.show', { id: product.publicId })
  }
}
