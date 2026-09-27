import { BaseMail } from '@adonisjs/mail'
import router from '@adonisjs/core/services/router'
import env from '#start/env'

import type LicenseFlag from '#models/license_flag'

/**
 * New abuse flags, to every admin (licence plan §9, M8). One email per run,
 * listing what was found; nothing has been done to any license.
 */
export default class LicenseAbuseNotification extends BaseMail {
  constructor(
    private email: string,
    private flags: LicenseFlag[]
  ) {
    super()
  }

  prepare() {
    const appUrl = env.get('APP_URL')

    const data = {
      flags: this.flags.map((flag) => ({
        description: flag.description,
        summary: flag.summary,
        product: flag.license.product.name,
        account: flag.license.organization.name,
        keySuffix: flag.license.keySuffix,
        url: `${appUrl}${router.makeUrl('admin.licenses.show', { id: flag.license.publicId })}`,
      })),
    }

    this.message
      .to(this.email)
      .subject(
        this.flags.length === 1
          ? 'A license was flagged for review'
          : `${this.flags.length} licenses were flagged for review`
      )
      .htmlView('emails/license_abuse', data)
      .textView('emails/license_abuse_text', data)
  }
}
