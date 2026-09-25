import type { HttpContext } from '@adonisjs/core/http'

import catalog, { CatalogError } from '#catalog/catalog_service'
import audit, { AUDIT_ACTIONS } from '#audit/audit_service'
import { planValidator } from '#validators/catalog'
import { redirectBackWithErrors } from '#admin/form_errors'

/**
 * A product's plans (licence plan §8, M1). Always addressed through the
 * product, so a plan id under the wrong product is a miss rather than a hit.
 */
export default class AdminPlanController {
  async create({ params, view, response, session, staffBouncer }: HttpContext) {
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    const product = await catalog.findProduct(params.id)

    if (!product) {
      session.flash('error', 'That product no longer exists.')
      return response.redirect().toRoute('admin.products.index')
    }

    return view.render('pages/admin/products/plan', { product, plan: null, canManage: true })
  }

  async store(ctx: HttpContext) {
    const { params, request, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    const product = await catalog.findProduct(params.id)

    if (!product) {
      session.flash('error', 'That product no longer exists.')
      return response.redirect().toRoute('admin.products.index')
    }

    const { price, ...payload } = await request.validateUsing(planValidator)

    try {
      const plan = await catalog.createPlan(product, {
        ...payload,
        priceCents: price,
        isPublic: payload.isPublic ?? false,
      })

      await catalog.setPlanEntitlements(product, plan, request.input('entitlements'))

      await audit.recordStaffAction(ctx, {
        action: AUDIT_ACTIONS.planCreated,
        subjectType: 'Plan',
        subjectId: plan.publicId,
        metadata: {
          product: product.slug,
          slug: plan.slug,
          billing: plan.billing,
          priceCents: plan.priceCents,
          currency: plan.currency,
        },
      })

      session.flash('success', `${plan.name} added to ${product.name}.`)
      return response.redirect().toRoute('admin.products.show', { id: product.publicId })
    } catch (error) {
      if (error instanceof CatalogError) return redirectBackWithErrors(ctx, error.errors)
      throw error
    }
  }

  async edit({ params, view, response, session, staffBouncer }: HttpContext) {
    await staffBouncer.with('StaffPolicy').authorize('view')

    const product = await catalog.findProduct(params.id)
    const plan = product ? await catalog.findPlan(product, params.planId) : null

    if (!product || !plan) {
      session.flash('error', 'That plan no longer exists.')
      return response.redirect().toRoute('admin.products.index')
    }

    return view.render('pages/admin/products/plan', {
      product,
      plan,
      canManage: await staffBouncer.with('StaffPolicy').allows('manageCatalog'),
    })
  }

  async update(ctx: HttpContext) {
    const { params, request, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    const product = await catalog.findProduct(params.id)
    const plan = product ? await catalog.findPlan(product, params.planId) : null

    if (!product || !plan) {
      session.flash('error', 'That plan no longer exists.')
      return response.redirect().toRoute('admin.products.index')
    }

    const { price, ...payload } = await request.validateUsing(planValidator)
    const before = {
      priceCents: plan.priceCents,
      maxActivations: plan.maxActivations,
      entitlements: plan.entitlements,
    }

    try {
      await catalog.updatePlan(product, plan, {
        ...payload,
        priceCents: price,
        isPublic: payload.isPublic ?? false,
      })
      await catalog.setPlanEntitlements(product, plan, request.input('entitlements'))
    } catch (error) {
      if (error instanceof CatalogError) return redirectBackWithErrors(ctx, error.errors)
      throw error
    }

    await audit.recordStaffAction(ctx, {
      action: AUDIT_ACTIONS.planUpdated,
      subjectType: 'Plan',
      subjectId: plan.publicId,
      metadata: {
        product: product.slug,
        before,
        after: {
          priceCents: plan.priceCents,
          maxActivations: plan.maxActivations,
          entitlements: plan.entitlements,
        },
      },
    })

    session.flash('success', `${plan.name} saved.`)
    return response.redirect().toRoute('admin.plans.edit', {
      id: product.publicId,
      planId: plan.publicId,
    })
  }

  /**
   * Archive or restore, whichever it is not. Archived plans cannot be bought
   * and keep working for everybody who already bought one.
   */
  async archive(ctx: HttpContext) {
    const { params, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageCatalog')

    const product = await catalog.findProduct(params.id)
    const plan = product ? await catalog.findPlan(product, params.planId) : null

    if (!product || !plan) {
      session.flash('error', 'That plan no longer exists.')
      return response.redirect().toRoute('admin.products.index')
    }

    const archiving = !plan.isArchived
    await catalog.setPlanArchived(plan, archiving)

    await audit.recordStaffAction(ctx, {
      action: archiving ? AUDIT_ACTIONS.planArchived : AUDIT_ACTIONS.planRestored,
      subjectType: 'Plan',
      subjectId: plan.publicId,
      metadata: { product: product.slug, slug: plan.slug },
    })

    session.flash(
      'success',
      archiving
        ? `${plan.name} archived. Nobody new can buy it; existing licenses are unaffected.`
        : `${plan.name} is on sale again.`
    )

    return response.redirect().toRoute('admin.products.show', { id: product.publicId })
  }
}
