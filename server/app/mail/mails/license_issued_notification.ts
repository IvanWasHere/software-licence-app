import { BaseMail } from '@adonisjs/mail'
import router from '@adonisjs/core/services/router'
import env from '#start/env'

import type License from '#models/license'

/**
 * The keys a paid order bought (licence plan §5.3, M4) — the one email the
 * whole purchase exists to produce.
 *
 * Sent to the address the order was placed with. When the account behind it
 * has no password yet (it was made by this purchase), the email says how to
 * set one: through the ordinary reset form, so no long-lived sign-in link is
 * ever put in an inbox.
 *
 * Only sent after fulfilment commits, and fulfilment only issues licenses for
 * items that have none, so a redelivered webhook cannot send it twice.
 */
export default class LicenseIssuedNotification extends BaseMail {
  constructor(
    private email: string,
    private issued: { license: License; key: string }[],
    private options: { needsPassword: boolean }
  ) {
    super()
  }

  prepare() {
    const appUrl = env.get('APP_URL')
    const licenses = this.issued.map(({ license, key }) => ({
      key,
      product: license.product.name,
      plan: license.plan.name,
      expiresAt: license.expiresAt?.toUTC().toFormat('d LLLL yyyy') ?? null,
      maxActivations: license.maxActivations ?? null,
    }))

    const data = {
      licenses,
      needsPassword: this.options.needsPassword,
      email: this.email,
      setPasswordUrl: `${appUrl}${router.makeUrl('auth.password.create')}`,
      loginUrl: `${appUrl}${router.makeUrl('auth.session.create')}`,
    }

    const first = licenses[0]

    this.message
      .to(this.email)
      .subject(
        licenses.length === 1
          ? `Your ${first.product} license key`
          : `Your ${licenses.length} license keys`
      )
      .htmlView('emails/license_issued', data)
      .textView('emails/license_issued_text', data)
  }
}
