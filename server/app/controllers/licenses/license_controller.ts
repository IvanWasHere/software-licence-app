import type { HttpContext } from '@adonisjs/core/http'

import License from '#models/license'
import activations from '#licensing/activation_service'
import licenses, { type LicenseActor } from '#licensing/license_service'

/**
 * The customer's licenses (licence plan §6, M5): keys, where each one is
 * installed, and the button that frees a slot.
 *
 * Open to every member of the account, not only the owner: the people who
 * install the software are the ones who need the key, and on an agency
 * account that is rarely the person who paid. Billing stays owner-only.
 *
 * Tenancy is in the lookup — `where organization_id` beside `where
 * public_id` — so another account's license id behaves exactly like one that
 * does not exist.
 */
export default class LicenseController {
  async index({ organization, view }: HttpContext) {
    const rows = await License.query()
      .where('organization_id', organization.id)
      .preload('product')
      .preload('plan')
      .preload('subscription')
      .orderBy('id', 'desc')

    const usage = new Map<number, Awaited<ReturnType<typeof activations.usage>>>()

    for (const license of rows) {
      usage.set(license.id, await activations.usage(license))
    }

    return view.render('pages/licenses/index', { licenses: rows, usage })
  }

  async show({ params, organization, view, response, session }: HttpContext) {
    const license = await this.find(organization.id, params.id)

    if (!license) {
      session.flash('error', 'No such license.')
      return response.redirect().toRoute('licenses.index')
    }

    const [live, usage, entitlements] = await Promise.all([
      activations.live(license),
      activations.usage(license),
      licenses.entitlements(license),
    ])

    return view.render('pages/licenses/show', {
      license,
      activations: live,
      usage,
      entitlements: Object.entries(entitlements),
      revealedKey: session.flashMessages.get('revealedKey') ?? null,
    })
  }

  /**
   * Show the key. A POST, and recorded in the license history, because a key
   * on a screen is one more place it now exists.
   */
  async reveal(ctx: HttpContext) {
    const { params, organization, response, session } = ctx
    const license = await this.find(organization.id, params.id)

    if (!license) {
      session.flash('error', 'No such license.')
      return response.redirect().toRoute('licenses.index')
    }

    session.flash('revealedKey', await licenses.revealKey(license, this.actor(ctx)))
    return response.redirect().toRoute('licenses.show', { id: license.publicId })
  }

  /**
   * Free a slot — the site was rebuilt or the server is gone. The installation
   * itself is not told; its next validation answers `not_activated`.
   */
  async deactivate(ctx: HttpContext) {
    const { params, organization, response, session } = ctx
    const license = await this.find(organization.id, params.id)
    const activation = license ? await activations.find(license, params.activationId) : null

    if (!license || !activation) {
      session.flash('error', 'That installation no longer exists.')
      return response.redirect().toRoute('licenses.index')
    }

    await activations.deactivateActivation(license, activation, this.actor(ctx))

    session.flash('success', `${activation.displayName} deactivated. Its slot is free.`)
    return response.redirect().toRoute('licenses.show', { id: license.publicId })
  }

  private find(organizationId: number, publicId: string) {
    return License.query()
      .where('organization_id', organizationId)
      .where('public_id', publicId)
      .preload('product')
      .preload('plan')
      .preload('subscription')
      .first()
  }

  private actor(ctx: HttpContext): LicenseActor {
    return { type: 'user', id: ctx.auth.use('web').user!.id }
  }
}
