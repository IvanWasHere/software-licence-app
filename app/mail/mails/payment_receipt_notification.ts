import { BaseMail } from '@adonisjs/mail'
import router from '@adonisjs/core/services/router'
import env from '#start/env'

import type User from '#models/user'
import type Payment from '#models/payment'
import type Receipt from '#models/receipt'
import type Organization from '#models/organization'

/**
 * A receipt for a charge that succeeded.
 *
 * Sent only when the payment row is **new** (see WebhookHandler): the same
 * order arriving again is a retry, and a customer who is charged once must be
 * emailed once.
 */
export default class PaymentReceiptNotification extends BaseMail {
  constructor(
    private user: User,
    private organization: Organization,
    private payment: Payment,
    /**
     * The numbered receipt (licence plan M9), attached as a PDF. Optional
     * because issuing it can fail without the charge being any less real;
     * the portal issues it again on the first download.
     */
    private receipt: { receipt: Receipt; pdf: Buffer } | null = null
  ) {
    super()
  }

  prepare() {
    const url = `${env.get('APP_URL')}${router.makeUrl('billing.index')}`
    const receiptUrl = this.receipt
      ? `${env.get('APP_URL')}${router.makeUrl('billing.receipt', { id: this.payment.publicId })}`
      : null

    const data = {
      user: this.user,
      organization: this.organization,
      payment: this.payment,
      amount: this.payment.formattedAmount,
      paidAt: this.payment.occurredAt.setZone(this.organization.timezone),
      url,
      receipt: this.receipt?.receipt ?? null,
      receiptUrl,
    }

    if (this.receipt) {
      this.message.attachData(this.receipt.pdf, {
        filename: this.receipt.receipt.fileName,
        contentType: 'application/pdf',
      })
    }

    this.message
      .to(this.user.email)
      .subject(`Your ${this.payment.formattedAmount} payment to ${env.get('APP_NAME', 'Acme')}`)
      .htmlView('emails/payment_receipt', data)
      .textView('emails/payment_receipt_text', data)
  }
}
