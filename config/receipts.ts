import env from '#start/env'

/**
 * The company on the receipt PDFs (licence plan M9).
 *
 * Read from the environment rather than from a settings screen because the
 * details change about as often as the domain does, and the deploy kit
 * already keeps that kind of fact in one file (`deploy/.env`).
 */
const receiptsConfig = {
  company: {
    name: env.get('COMPANY_NAME') ?? env.get('APP_NAME', 'Acme'),
    addressLines: (env.get('COMPANY_ADDRESS') ?? '')
      .split('|')
      .map((line) => line.trim())
      .filter(Boolean),
    email: env.get('COMPANY_EMAIL') ?? env.get('MAIL_FROM_ADDRESS', ''),
    taxId: env.get('COMPANY_TAX_ID') ?? null,
  },

  /**
   * `R-2026-000042`: the prefix, the year the receipt was issued in, and a
   * number that only ever grows.
   */
  numberPrefix: 'R',
} as const

export default receiptsConfig
