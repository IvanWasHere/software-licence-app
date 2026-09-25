import { DateTime } from 'luxon'
import type { HttpContext } from '@adonisjs/core/http'

import Plan from '#models/plan'
import License from '#models/license'
import Product from '#models/product'
import search from '#admin/search_service'
import audit, { AUDIT_ACTIONS } from '#audit/audit_service'
import activations from '#licensing/activation_service'
import licenses, { LicenseError, type LicenseActor } from '#licensing/license_service'
import { redirectBackWithErrors } from '#admin/form_errors'
import {
  issueLicenseValidator,
  licenseActivationsValidator,
  licenseExpiryValidator,
  licenseReasonValidator,
} from '#validators/license'

/**
 * Licenses in the back-office (licence plan §8, M2).
 *
 * Two levels of power, by blast radius as everywhere else here:
 * `assistLicense` (support) reads a key back and frees an activation slot;
 * `manageLicenses` (admin) issues, suspends, revokes, re-keys and changes
 * what a license allows.
 *
 * Every action is recorded twice, on purpose: in the license's own history
 * (what happened to this license) by the service, and in the audit log (what
 * did this staff member do) here.
 */
export default class AdminLicenseController {
  async index({ request, view, staffBouncer }: HttpContext) {
    await staffBouncer.with('StaffPolicy').authorize('view')

    const term = String(request.input('q', ''))
    const status = ['active', 'suspended', 'revoked'].includes(request.input('status'))
      ? (request.input('status') as License['status'])
      : null
    const productPublicId = String(request.input('product', ''))
    const product = productPublicId
      ? await Product.query().where('public_id', productPublicId).first()
      : null

    return view.render('pages/admin/licenses/index', {
      term,
      status,
      productPublicId: product?.publicId ?? '',
      products: await Product.query().orderBy('name', 'asc'),
      licenses: await search.licenses(term, { status, productId: product?.id ?? null }),
      canManage: await staffBouncer.with('StaffPolicy').allows('manageLicenses'),
    })
  }

  async create({ request, view, staffBouncer }: HttpContext) {
    await staffBouncer.with('StaffPolicy').authorize('manageLicenses')

    return view.render('pages/admin/licenses/create', {
      plans: await this.issuablePlans(),
      customer: String(request.input('customer', '')),
    })
  }

  async store(ctx: HttpContext) {
    const { request, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageLicenses')

    const payload = await request.validateUsing(issueLicenseValidator)

    const organization = await search.customer(payload.customer)

    if (!organization) {
      return redirectBackWithErrors(ctx, {
        customer: 'No customer matches that. Use an organisation id (org_…) or an exact email.',
      })
    }

    const plan = await Plan.query().where('public_id', payload.plan).first()

    if (!plan) {
      return redirectBackWithErrors(ctx, { plan: 'Choose a plan.' })
    }

    try {
      const { license, key } = await licenses.issue({
        organization,
        plan,
        source: 'manual',
        actor: this.actor(ctx),
        expiresAt: payload.expiresAt ? endOfDay(payload.expiresAt) : null,
        notes: payload.notes ?? null,
      })

      await audit.recordStaffAction(ctx, {
        action: AUDIT_ACTIONS.licenseIssued,
        organization,
        subjectType: 'License',
        subjectId: license.publicId,
        metadata: { plan: plan.slug, suffix: license.keySuffix },
      })

      session.flash('revealedKey', key)
      session.flash(
        'success',
        'License issued. The key is below — it is also in the customer’s account.'
      )
      return response.redirect().toRoute('admin.licenses.show', { id: license.publicId })
    } catch (error) {
      if (error instanceof LicenseError) {
        return redirectBackWithErrors(ctx, { [error.field ?? 'plan']: error.message })
      }
      throw error
    }
  }

  async show({ params, view, response, session, staffBouncer }: HttpContext) {
    await staffBouncer.with('StaffPolicy').authorize('view')

    const license = await this.find(params.id)

    if (!license) {
      session.flash('error', 'No such license.')
      return response.redirect().toRoute('admin.licenses.index')
    }

    const [rows, usage, entitlements, history, canManage, canAssist] = await Promise.all([
      activations.all(license),
      activations.usage(license),
      licenses.entitlements(license),
      licenses.history(license),
      staffBouncer.with('StaffPolicy').allows('manageLicenses'),
      staffBouncer.with('StaffPolicy').allows('assistLicense'),
    ])

    return view.render('pages/admin/licenses/show', {
      license,
      activations: rows,
      usage,
      entitlements: Object.entries(entitlements),
      history,
      canManage,
      canAssist,
      revealedKey: session.flashMessages.get('revealedKey') ?? null,
    })
  }

  /**
   * Read the key back — the most common license ticket there is.
   */
  async reveal(ctx: HttpContext) {
    const { params, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('assistLicense')

    const license = await this.find(params.id)

    if (!license) {
      session.flash('error', 'No such license.')
      return response.redirect().toRoute('admin.licenses.index')
    }

    const key = await licenses.revealKey(license, this.actor(ctx))

    await audit.recordStaffAction(ctx, {
      action: AUDIT_ACTIONS.licenseKeyRevealed,
      organization: { id: license.organizationId },
      subjectType: 'License',
      subjectId: license.publicId,
    })

    session.flash('revealedKey', key)
    return response.redirect().toRoute('admin.licenses.show', { id: license.publicId })
  }

  async suspend(ctx: HttpContext) {
    return this.withReason(ctx, AUDIT_ACTIONS.licenseSuspended, (license, reason, actor) =>
      licenses.suspend(license, reason, actor)
    )
  }

  async revoke(ctx: HttpContext) {
    return this.withReason(ctx, AUDIT_ACTIONS.licenseRevoked, (license, reason, actor) =>
      licenses.revoke(license, reason, actor)
    )
  }

  async resume(ctx: HttpContext) {
    return this.act(ctx, AUDIT_ACTIONS.licenseResumed, 'License resumed.', (license, actor) =>
      licenses.resume(license, actor)
    )
  }

  async reissue(ctx: HttpContext) {
    const { session } = ctx

    return this.act(
      ctx,
      AUDIT_ACTIONS.licenseKeyReissued,
      'New key issued. The old key stopped working immediately; activations were kept.',
      async (license, actor) => {
        const { key } = await licenses.reissueKey(license, actor)
        session.flash('revealedKey', key)
      }
    )
  }

  async expiry(ctx: HttpContext) {
    await ctx.staffBouncer.with('StaffPolicy').authorize('manageLicenses')
    const { expiresAt } = await ctx.request.validateUsing(licenseExpiryValidator)

    return this.act(
      ctx,
      AUDIT_ACTIONS.licenseExpiryChanged,
      expiresAt ? `License now expires at the end of ${expiresAt}.` : 'License no longer expires.',
      (license, actor) =>
        licenses.changeExpiry(license, expiresAt ? endOfDay(expiresAt) : null, actor),
      { expiresAt: expiresAt ?? null }
    )
  }

  async activationsLimit(ctx: HttpContext) {
    await ctx.staffBouncer.with('StaffPolicy').authorize('manageLicenses')
    const { maxActivations } = await ctx.request.validateUsing(licenseActivationsValidator)

    return this.act(
      ctx,
      AUDIT_ACTIONS.licenseActivationsLimitChanged,
      maxActivations
        ? `Activation limit set to ${maxActivations}. Nothing already active was switched off.`
        : 'Activations are now unlimited.',
      (license, actor) => licenses.setMaxActivations(license, maxActivations ?? null, actor),
      { maxActivations: maxActivations ?? null }
    )
  }

  /**
   * Free a slot — the site was rebuilt, the server is gone. Support-level.
   */
  async deactivateActivation(ctx: HttpContext) {
    const { params, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('assistLicense')

    const license = await this.find(params.id)
    const activation = license ? await activations.find(license, params.activationId) : null

    if (!license || !activation) {
      session.flash('error', 'That activation no longer exists.')
      return response.redirect().toRoute('admin.licenses.index')
    }

    await activations.deactivateActivation(license, activation, this.actor(ctx))

    await audit.recordStaffAction(ctx, {
      action: AUDIT_ACTIONS.licenseActivationRemoved,
      organization: { id: license.organizationId },
      subjectType: 'License',
      subjectId: license.publicId,
      metadata: { activation: activation.publicId, site: activation.displayName },
    })

    session.flash('success', `${activation.displayName} deactivated. The slot is free.`)
    return response.redirect().toRoute('admin.licenses.show', { id: license.publicId })
  }

  /**
   * The admin-only actions that take a written reason. The reason goes into
   * the license history, where the customer-facing portal can show it later.
   */
  private async withReason(
    ctx: HttpContext,
    action: (typeof AUDIT_ACTIONS)['licenseSuspended' | 'licenseRevoked'],
    apply: (license: License, reason: string, actor: LicenseActor) => Promise<unknown>
  ) {
    await ctx.staffBouncer.with('StaffPolicy').authorize('manageLicenses')
    const { reason } = await ctx.request.validateUsing(licenseReasonValidator)
    const done = action === AUDIT_ACTIONS.licenseRevoked ? 'License revoked.' : 'License suspended.'

    return this.act(ctx, action, done, (license, actor) => apply(license, reason, actor), {
      reason,
    })
  }

  private async act(
    ctx: HttpContext,
    action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
    done: string,
    apply: (license: License, actor: LicenseActor) => Promise<unknown>,
    metadata: Record<string, any> = {}
  ) {
    const { params, response, session, staffBouncer } = ctx
    await staffBouncer.with('StaffPolicy').authorize('manageLicenses')

    const license = await this.find(params.id)

    if (!license) {
      session.flash('error', 'No such license.')
      return response.redirect().toRoute('admin.licenses.index')
    }

    try {
      await apply(license, this.actor(ctx))
    } catch (error) {
      if (error instanceof LicenseError) {
        session.flash('error', error.message)
        return response.redirect().toRoute('admin.licenses.show', { id: license.publicId })
      }
      throw error
    }

    await audit.recordStaffAction(ctx, {
      action,
      organization: { id: license.organizationId },
      subjectType: 'License',
      subjectId: license.publicId,
      metadata,
    })

    session.flash('success', done)
    return response.redirect().toRoute('admin.licenses.show', { id: license.publicId })
  }

  private async find(publicId: string): Promise<License | null> {
    return License.query()
      .where('public_id', publicId)
      .preload('product')
      .preload('plan')
      .preload('organization')
      .preload('subscription')
      .first()
  }

  /**
   * Plans a license can be issued on: not archived, product not retired.
   * Hidden plans are included — issuing an off-menu plan by hand is exactly
   * what hidden plans are for.
   */
  private async issuablePlans(): Promise<Plan[]> {
    const plans = await Plan.query()
      .where('status', 'active')
      .preload('product')
      .orderBy('product_id', 'asc')
      .orderBy('sort_order', 'asc')

    return plans.filter((plan) => plan.product.status !== 'retired')
  }

  private actor(ctx: HttpContext): LicenseActor {
    return { type: 'staff', id: ctx.auth.use('staff').user?.id ?? null }
  }
}

/**
 * A date picked in a form means that whole day is still good. Truncated to
 * the second, which is what the column stores, so the value in memory and
 * the value read back are the same instant.
 */
function endOfDay(date: string): DateTime {
  return DateTime.fromISO(date, { zone: 'utc' }).endOf('day').set({ millisecond: 0 })
}
