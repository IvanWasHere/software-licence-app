import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'

import Order from '#models/order'
import Payment from '#models/payment'
import Receipt from '#models/receipt'
import Organization from '#models/organization'
import Subscription from '#models/subscription'
import storage from '#storage/disk_storage'
import receiptsConfig from '#config/receipts'
import { renderReceiptPdf, type ReceiptContent, type ReceiptLine } from '#billing/receipt_pdf'

/**
 * Receipts (licence plan M9): one numbered PDF per successful charge.
 *
 * Issued when a payment is first recorded, and lazily for anything that was
 * paid before receipts existed — the portal's download issues one on the
 * spot. The row is the record; the PDF is a rendering of it that can be
 * redrawn if the object store lost it.
 */
export class ReceiptService {
  /**
   * The receipt for a payment, issued now if it has none. Idempotent: a
   * second call for the same payment returns the first receipt.
   */
  async issue(payment: Payment): Promise<Receipt> {
    const existing = await Receipt.findBy('payment_id', payment.id)

    if (existing) {
      return existing
    }

    const organization = await Organization.findOrFail(payment.organizationId)
    const issuedAt = DateTime.utc()

    /**
     * The number needs the row's id, so the row is written twice inside one
     * transaction; nothing sees the placeholder.
     */
    const receipt = await db.transaction(async (trx) => {
      const row = new Receipt()
      row.useTransaction(trx)
      row.merge({
        organizationId: organization.id,
        paymentId: payment.id,
        amountCents: payment.amountCents,
        currency: payment.currency,
        issuedAt,
        number: `pending`,
        storageKey: 'pending',
      })
      await row.save()

      row.number = this.numberFor(row.id, issuedAt)
      row.storageKey = `receipts/${organization.publicId}/${row.number}.pdf`
      await row.save()

      return row
    })

    await this.store(receipt, payment, organization)

    return receipt
  }

  /**
   * The PDF's bytes: read from storage, or drawn again if it is missing —
   * a bucket restored from an older backup, say.
   */
  async pdf(receipt: Receipt): Promise<Buffer> {
    if (await storage.exists({ disk: 'private', key: receipt.storageKey })) {
      return storage.readBytes({ disk: 'private', key: receipt.storageKey })
    }

    const [payment, organization] = await Promise.all([
      Payment.findOrFail(receipt.paymentId),
      Organization.findOrFail(receipt.organizationId),
    ])

    return this.store(receipt, payment, organization)
  }

  /**
   * What the receipt says, as data. Line items come from the order the
   * payment settled; a renewal has no order, so its line is the
   * subscription's plan; a payment we can tie to neither is described the
   * way the provider described it.
   */
  async content(receipt: Receipt, payment: Payment, organization: Organization) {
    const lines = await this.lines(payment)
    const total = lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0)

    /**
     * The lines are what was bought; the total is what was charged. When a
     * discount or a provider fee makes them differ, the charge wins and an
     * adjustment line says by how much, so the PDF never disagrees with the
     * card statement.
     */
    if (total !== receipt.amountCents) {
      lines.push({
        description: total > receipt.amountCents ? 'Adjustment' : 'Other charges',
        quantity: 1,
        unitCents: receipt.amountCents - total,
      })
    }

    const content: ReceiptContent = {
      number: receipt.number,
      issuedOn: receipt.issuedAt.setZone(organization.timezone).toFormat('d LLLL yyyy'),
      company: receiptsConfig.company,
      billedTo: { name: organization.name, email: await this.emailFor(payment, organization) },
      lines,
      totalCents: receipt.amountCents,
      currency: receipt.currency,
      paymentReference: payment.providerOrderId,
      note: `Paid on ${payment.occurredAt.setZone(organization.timezone).toFormat('d LLLL yyyy')} through Creem, the merchant of record for this purchase. Creem issues the tax invoice; this receipt confirms the order with ${receiptsConfig.company.name}.`,
    }

    return content
  }

  private async lines(payment: Payment): Promise<ReceiptLine[]> {
    const order = await Order.query()
      .where('provider_order_id', payment.providerOrderId)
      .preload('items', (items) => items.preload('plan', (plan) => plan.preload('product')))
      .first()

    if (order && order.items.length) {
      return order.items.map((item) => ({
        description: `${item.plan.product.name} · ${item.plan.name}`,
        quantity: item.quantity,
        unitCents: item.unitPriceCents,
      }))
    }

    const subscription = payment.subscriptionId
      ? await Subscription.query()
          .where('id', payment.subscriptionId)
          .preload('plan', (plan) => plan.preload('product'))
          .first()
      : null

    if (subscription?.plan) {
      return [
        {
          description: `${subscription.plan.product.name} · ${subscription.plan.name} — renewal`,
          quantity: 1,
          unitCents: payment.amountCents,
        },
      ]
    }

    return [
      {
        description: payment.description ?? 'Payment',
        quantity: 1,
        unitCents: payment.amountCents,
      },
    ]
  }

  /**
   * The address the order was placed with, when there was an order; the
   * account owner's otherwise.
   */
  private async emailFor(payment: Payment, organization: Organization): Promise<string> {
    const order = await Order.findBy('provider_order_id', payment.providerOrderId)

    if (order) {
      return order.email
    }

    const { default: User } = await import('#models/user')
    const owner = await User.query()
      .where('organization_id', organization.id)
      .where('role', 'owner')
      .whereNull('deleted_at')
      .first()

    return owner?.email ?? ''
  }

  private numberFor(id: number, issuedAt: DateTime): string {
    return `${receiptsConfig.numberPrefix}-${issuedAt.toFormat('yyyy')}-${String(id).padStart(6, '0')}`
  }

  private async store(receipt: Receipt, payment: Payment, organization: Organization) {
    const pdf = await renderReceiptPdf(await this.content(receipt, payment, organization))

    await storage.putBytes({
      disk: 'private',
      key: receipt.storageKey,
      bytes: pdf,
      contentType: 'application/pdf',
    })

    return pdf
  }
}

export default new ReceiptService()
