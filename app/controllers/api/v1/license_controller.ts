import type { HttpContext } from '@adonisjs/core/http'

import Product from '#models/product'
import signer from '#licensing/signer'
import activations from '#licensing/activation_service'
import licenses, { type LicenseActor } from '#licensing/license_service'
import {
  activationSummary,
  envelope,
  licenseSummary,
  policyFor,
  withSignature,
} from '#licensing/api_payload'
import {
  activateLicenseValidator,
  deactivateLicenseValidator,
  validateLicenseValidator,
} from '#validators/license_api'

/**
 * The customer's software is the actor on this surface. It has no id of its
 * own; the license history records the instance in the event's metadata.
 */
const CLIENT: LicenseActor = { type: 'client', id: null }

/**
 * The public license API (licence plan §6).
 *
 * Authenticated by what the software holds — product slug plus license key —
 * and nothing else: no API key, no session. An invalid license is a
 * **business answer**, `200` with `valid: false` and a reason code; a 4xx
 * means the request itself was wrong (422) or too frequent (429). SDKs
 * branch on `reason`, never on the status.
 */
export default class LicenseApiController {
  async validate(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(validateLicenseValidator)
    const { result, license, activation } = await licenses.check(
      payload.license_key,
      payload.product,
      payload.instance_id
    )

    /**
     * The heartbeat: a validated installation is one still in use.
     */
    if (result.valid && activation) {
      await activations.touch(activation)
    }

    const product = license?.product ?? (await Product.findBy('slug', payload.product))
    const matched = license && license.product.slug === payload.product

    return ctx.response.ok(
      withSignature({
        valid: result.valid,
        reason: result.reason,
        license: matched ? licenseSummary(license, await activations.usage(license)) : null,
        activation: result.valid && activation ? activationSummary(activation) : null,
        entitlements: result.valid ? await licenses.entitlements(license!) : {},
        policy: policyFor(matched ? license.product : product),
        ...this.envelope(ctx, payload),
      })
    )
  }

  /**
   * Activate this installation. Idempotent: the same `instance_id` twice is
   * one activation, so a client that retries after a timeout costs the
   * customer nothing.
   */
  async activate(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(activateLicenseValidator)
    const { result, license } = await licenses.check(payload.license_key, payload.product)

    if (!result.valid) {
      return ctx.response.ok(
        withSignature({
          activated: false,
          valid: false,
          reason: result.reason,
          license:
            license && license.product.slug === payload.product
              ? licenseSummary(license, await activations.usage(license))
              : null,
          activation: null,
          entitlements: {},
          policy: policyFor(license?.product ?? null),
          ...this.envelope(ctx, payload),
        })
      )
    }

    const outcome = await activations.activate(
      license!,
      {
        instanceId: payload.instance_id,
        siteUrl: payload.site_url,
        label: payload.label,
        clientVersion: payload.client_version,
        ip: ctx.request.ip(),
        userAgent: ctx.request.header('user-agent'),
      },
      CLIENT
    )

    const usage = await activations.usage(license!)

    if (!outcome.ok) {
      return ctx.response.ok(
        withSignature({
          activated: false,
          valid: false,
          reason: outcome.reason,
          license: licenseSummary(license!, usage),
          activation: null,
          entitlements: {},
          policy: policyFor(license!.product),
          ...this.envelope(ctx, payload),
        })
      )
    }

    return ctx.response.ok(
      withSignature({
        activated: true,
        valid: true,
        reason: null,
        license: licenseSummary(license!, usage),
        activation: activationSummary(outcome.activation),
        entitlements: await licenses.entitlements(license!),
        policy: policyFor(license!.product),
        ...this.envelope(ctx, payload),
      })
    )
  }

  /**
   * Release this installation's slot. Works whatever the license's state —
   * an expired or suspended customer must still be able to tidy up — but
   * only for the right key and product.
   *
   * `deactivated: false` with no reason means "it was not active", which is
   * not an error: a client may not know whether its last attempt landed.
   */
  async deactivate(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(deactivateLicenseValidator)
    const { license } = await licenses.check(payload.license_key, payload.product)

    if (!license || license.product.slug !== payload.product) {
      return ctx.response.ok(
        withSignature({
          deactivated: false,
          reason: license ? 'product_mismatch' : 'invalid_license',
          ...this.envelope(ctx, payload),
        })
      )
    }

    const deactivated = await activations.deactivate(license, payload.instance_id, CLIENT)

    return ctx.response.ok(
      withSignature({
        deactivated,
        reason: null,
        license: licenseSummary(license, await activations.usage(license)),
        ...this.envelope(ctx, payload),
      })
    )
  }

  /**
   * The public keys responses are signed with (licence plan §5.2). SDKs ship
   * with the key pinned; this is how a rotation is announced.
   */
  async keys({ response }: HttpContext) {
    return response.ok({ data: signer.publishedKeys() })
  }

  /**
   * Browsers send a preflight before a JSON POST. `LicenseApiMiddleware`
   * answers it before this is reached; the route only has to exist.
   */
  async preflight({ response }: HttpContext) {
    return response.noContent()
  }

  private envelope(
    ctx: HttpContext,
    payload: { product: string; instance_id?: string | null; nonce?: string | null }
  ) {
    return envelope({
      requestId: String(ctx.response.getHeader('x-request-id') ?? ''),
      product: payload.product,
      instanceId: payload.instance_id,
      nonce: payload.nonce,
    })
  }
}
