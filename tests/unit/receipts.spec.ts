import { test } from '@japa/runner'

import { renderReceiptPdf, type ReceiptContent } from '#billing/receipt_pdf'

/**
 * The PDF renderer (licence plan M9), as a black box: what it says is
 * `ReceiptContent`, decided elsewhere and asserted on elsewhere; here only
 * that it produces a PDF, whole, for the shapes it is given.
 */
test.group('Receipt PDF', () => {
  const content: ReceiptContent = {
    number: 'R-2026-000042',
    issuedOn: '26 September 2026',
    company: {
      name: 'Acme Ltd',
      addressLines: ['1 Example Street', '12345 Example City'],
      email: 'billing@example.com',
      taxId: 'DE123456789',
    },
    billedTo: { name: 'Buyer Co', email: 'buyer@example.com' },
    lines: [
      { description: 'Invoice Pro · Lifetime', quantity: 1, unitCents: 29_900 },
      { description: 'Invoice Pro · Extra sites', quantity: 3, unitCents: 1_000 },
    ],
    totalCents: 32_900,
    currency: 'EUR',
    paymentReference: 'ord_creem_1',
    note: 'Paid through Creem.',
  }

  test('renders a complete PDF', async ({ assert }) => {
    const pdf = await renderReceiptPdf(content)

    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    assert.include(pdf.subarray(-32).toString(), '%%EOF')
    assert.isAbove(pdf.length, 1_000)
  })

  test('carries its number and author in the document metadata', async ({ assert }) => {
    const bytes = await renderReceiptPdf(content)
    const pdf = bytes.toString('latin1')

    /**
     * The info dictionary is the one part pdfkit does not compress.
     */
    assert.include(pdf, 'Receipt R-2026-000042')
    assert.include(pdf, 'Acme Ltd')
  })

  test('copes with the sparsest company and a single line', async ({ assert }) => {
    const pdf = await renderReceiptPdf({
      ...content,
      company: { name: 'Acme', addressLines: [], email: '', taxId: null },
      lines: [{ description: 'Payment', quantity: 1, unitCents: 500 }],
      totalCents: 500,
    })

    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  })
})
