import PDFDocument from 'pdfkit'

import Payment from '#models/payment'

/**
 * Everything a receipt says, as plain data (licence plan M9). Built by
 * `ReceiptService`, drawn by `renderReceiptPdf`, and asserted on in tests
 * without opening a PDF.
 */
export interface ReceiptContent {
  number: string
  /** `26 September 2026` */
  issuedOn: string
  company: {
    name: string
    addressLines: readonly string[]
    email: string
    taxId: string | null
  }
  billedTo: {
    name: string
    email: string
  }
  lines: ReceiptLine[]
  totalCents: number
  currency: string
  /** The provider's order reference, so the receipt and Creem's invoice can be matched. */
  paymentReference: string
  /** Where the tax invoice is: the merchant of record. */
  note: string
}

export interface ReceiptLine {
  description: string
  quantity: number
  unitCents: number
}

const PAGE = { width: 595.28, margin: 56 } // A4, 2 cm

/**
 * One page, standard fonts, no images: a receipt that renders identically
 * on every machine and weighs a few kilobytes. Compression is left on;
 * tests assert on `ReceiptContent`, not on the bytes.
 */
export function renderReceiptPdf(content: ReceiptContent): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE.margin,
      info: {
        Title: `Receipt ${content.number}`,
        Author: content.company.name,
        Subject: `Receipt ${content.number} for ${content.billedTo.email}`,
      },
    })

    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const right = PAGE.width - PAGE.margin
    const money = (cents: number) => Payment.formatAmount(cents, content.currency)

    /**
     * Header: who it is from, and what it is.
     */
    doc.font('Helvetica-Bold').fontSize(18).text(content.company.name, PAGE.margin, PAGE.margin)
    doc.font('Helvetica').fontSize(9).fillColor('#555555')
    for (const line of content.company.addressLines) {
      doc.text(line)
    }
    if (content.company.email) {
      doc.text(content.company.email)
    }
    if (content.company.taxId) {
      doc.text(content.company.taxId)
    }

    doc.fillColor('#000000')
    doc
      .font('Helvetica-Bold')
      .fontSize(22)
      .text('Receipt', PAGE.margin, PAGE.margin, {
        width: right - PAGE.margin,
        align: 'right',
      })
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(content.number, { width: right - PAGE.margin, align: 'right' })
      .text(content.issuedOn, { width: right - PAGE.margin, align: 'right' })

    /**
     * Who paid.
     */
    let y = 170
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555555').text('BILLED TO', PAGE.margin, y)
    doc.fillColor('#000000').font('Helvetica').fontSize(10)
    doc.text(content.billedTo.name, PAGE.margin, y + 14)
    doc.text(content.billedTo.email)

    /**
     * The lines.
     */
    y = 240
    const columns = { description: PAGE.margin, quantity: 360, unit: 420, amount: right }

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555555')
    doc.text('DESCRIPTION', columns.description, y)
    doc.text('QTY', columns.quantity, y, { width: 40, align: 'right' })
    doc.text('UNIT', columns.unit, y, { width: 70, align: 'right' })
    doc.text('AMOUNT', columns.unit + 70, y, {
      width: columns.amount - columns.unit - 70,
      align: 'right',
    })
    y += 14
    doc.moveTo(PAGE.margin, y).lineTo(right, y).strokeColor('#cccccc').stroke()
    y += 10

    doc.fillColor('#000000').font('Helvetica').fontSize(10)
    for (const line of content.lines) {
      doc.text(line.description, columns.description, y, {
        width: columns.quantity - columns.description - 10,
      })
      doc.text(String(line.quantity), columns.quantity, y, { width: 40, align: 'right' })
      doc.text(money(line.unitCents), columns.unit, y, { width: 70, align: 'right' })
      doc.text(money(line.unitCents * line.quantity), columns.unit + 70, y, {
        width: columns.amount - columns.unit - 70,
        align: 'right',
      })
      y += 20
    }

    y += 6
    doc.moveTo(PAGE.margin, y).lineTo(right, y).strokeColor('#cccccc').stroke()
    y += 12
    doc.font('Helvetica-Bold').fontSize(11)
    doc.text('Total paid', columns.quantity, y, { width: 110, align: 'right' })
    doc.text(money(content.totalCents), columns.unit + 70, y, {
      width: columns.amount - columns.unit - 70,
      align: 'right',
    })

    /**
     * The footer: the provider's reference, and where the tax invoice is.
     */
    y += 40
    doc.font('Helvetica').fontSize(9).fillColor('#555555')
    doc.text(`Payment reference: ${content.paymentReference}`, PAGE.margin, y, {
      width: right - PAGE.margin,
    })
    doc.moveDown(0.5)
    doc.text(content.note, { width: right - PAGE.margin })

    doc.end()
  })
}
