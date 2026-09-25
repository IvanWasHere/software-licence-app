import { createHash, randomBytes } from 'node:crypto'

/**
 * License keys (licence plan §4).
 *
 * `WIPRO-7K4DX-82M91-QP6F3-A0ZT9` — the product's prefix, then four groups of
 * five Crockford base32 characters: 20 × 5 = 100 random bits.
 *
 * Only the **body** (the 20 random characters) identifies a license; the
 * prefix is for humans and the product check happens against the stored row.
 * That lets parsing be forgiving in the ways people actually get keys wrong —
 * lower case, missing or extra dashes, pasted whitespace, `O` for `0`, `I` or
 * `L` for `1` — without ever touching the prefix, which is free to contain
 * those letters (`WIPRO`).
 */

/**
 * Crockford's alphabet: no I, L, O or U. Thirty-two symbols, so one random
 * byte modulo 32 is unbiased.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BODY_LENGTH = 20
const GROUP_LENGTH = 5

export interface GeneratedKey {
  /**
   * The whole key. Shown once at issue, stored only encrypted.
   */
  key: string
  hash: string
  suffix: string
}

export function generateLicenseKey(prefix: string): GeneratedKey {
  const bytes = randomBytes(BODY_LENGTH)
  let body = ''

  for (const byte of bytes) {
    body += ALPHABET[byte % ALPHABET.length]
  }

  const groups = body.match(new RegExp(`.{${GROUP_LENGTH}}`, 'g'))!

  return {
    key: [prefix.toUpperCase(), ...groups].join('-'),
    hash: hashBody(body),
    suffix: body.slice(-4),
  }
}

/**
 * The lookup hash for whatever somebody typed, or `null` when it cannot be a
 * key at all — callers answer `invalid_license` without a query.
 */
export function licenseKeyHash(input: unknown): string | null {
  const body = licenseKeyBody(input)
  return body ? hashBody(body) : null
}

/**
 * The normalised random body of a key: the last twenty significant
 * characters, read with Crockford's decoding of look-alike letters.
 */
export function licenseKeyBody(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 128) {
    return null
  }

  const compact = input.toUpperCase().replace(/[^0-9A-Z]/g, '')

  if (compact.length < BODY_LENGTH) {
    return null
  }

  const body = compact.slice(-BODY_LENGTH).replace(/O/g, '0').replace(/[IL]/g, '1')

  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(body) ? body : null
}

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}
