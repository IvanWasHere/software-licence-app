import { BaseMail } from '@adonisjs/mail'
import router from '@adonisjs/core/services/router'
import env from '#start/env'

import type User from '#models/user'
import type License from '#models/license'
import type Organization from '#models/organization'

/**
 * A license that will not renew by itself is about to expire (licence plan
 * §5.5, M8). Sent 14 and 3 days before, once each per expiry date, to the
 * account's owner.
 */
export default class LicenseExpiringNotification extends BaseMail {
  constructor(
    private user: User,
    private organization: Organization,
    private license: License,
    private daysLeft: number
  ) {
    super()
  }

  prepare() {
    const appUrl = env.get('APP_URL')
    const productName = this.license.product.name

    const data = {
      user: this.user,
      productName,
      planName: this.license.plan.name,
      keySuffix: this.license.keySuffix,
      daysLeft: this.daysLeft,
      expiresAt: this.license.expiresAt!.setZone(this.organization.timezone),
      /**
       * A cancelled subscription is resumed from billing; anything else is
       * bought again from the product's pricing page.
       */
      renewUrl: this.license.subscriptionId
        ? `${appUrl}${router.makeUrl('billing.index')}`
        : `${appUrl}${router.makeUrl('storefront.pricing', { product: this.license.product.slug })}`,
      licenseUrl: `${appUrl}${router.makeUrl('licenses.show', { id: this.license.publicId })}`,
    }

    this.message
      .to(this.user.email)
      .subject(
        this.daysLeft <= 1
          ? `Your ${productName} license expires tomorrow`
          : `Your ${productName} license expires in ${this.daysLeft} days`
      )
      .htmlView('emails/license_expiring', data)
      .textView('emails/license_expiring_text', data)
  }
}
