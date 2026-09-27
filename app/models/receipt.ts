import { compose } from '@adonisjs/core/helpers'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import Payment from '#models/payment'
import Organization from '#models/organization'
import { ReceiptSchema } from '#database/schema'
import { withPublicId } from '#models/mixins/with_public_id'

/**
 * A numbered receipt for one successful charge (licence plan M9). The PDF
 * lives on the private disk under `storageKey`; the row is what makes the
 * number permanent.
 */
export default class Receipt extends compose(ReceiptSchema, withPublicId('receipt')) {
  @belongsTo(() => Organization)
  declare organization: BelongsTo<typeof Organization>

  @belongsTo(() => Payment)
  declare payment: BelongsTo<typeof Payment>

  /**
   * `receipt-R-2026-000042.pdf` — what the download and the attachment are
   * called.
   */
  get fileName() {
    return `receipt-${this.number}.pdf`
  }

  get formattedAmount() {
    return Payment.formatAmount(this.amountCents, this.currency)
  }
}
