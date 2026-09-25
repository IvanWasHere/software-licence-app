import { BaseMail } from '@adonisjs/mail'
import router from '@adonisjs/core/services/router'
import env from '#start/env'

import type User from '#models/user'
import type Organization from '#models/organization'
import type Subscription from '#models/subscription'

/**
 * A renewal was declined (licence plan §5.3). Sent once, on the transition to
 * `past_due`, never on a redelivery.
 *
 * Says when the license stops working — the end of the paid period plus the
 * renewal grace, which is exactly what the license's own expiry already is —
 * because "nothing has been switched off yet, and here is the date it will be"
 * is the sentence that gets a card updated.
 */
export default class PaymentFailedNotification extends BaseMail {
  constructor(
    private user: User,
    private organization: Organization,
    private subscription: Subscription,
    private details: { productName: string; licenseExpiresAt: import('luxon').DateTime | null }
  ) {
    super()
  }

  prepare() {
    const url = `${env.get('APP_URL')}${router.makeUrl('billing.index')}`

    const data = {
      user: this.user,
      organization: this.organization,
      subscription: this.subscription,
      productName: this.details.productName,
      graceEndsAt: this.details.licenseExpiresAt?.setZone(this.organization.timezone) ?? null,
      url,
    }

    this.message
      .to(this.user.email)
      .subject(`We could not renew your ${this.details.productName} license`)
      .htmlView('emails/payment_failed', data)
      .textView('emails/payment_failed_text', data)
  }
}
