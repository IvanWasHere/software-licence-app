import { test } from '@japa/runner'

import signer from '#licensing/signer'
import { LICENSE_REASONS } from '#licensing/reasons'
import { isDevHostname, normalizeHostname } from '#licensing/hostnames'
import { evaluateLicense, type LicenseFacts } from '#licensing/validation'
import { generateLicenseKey, licenseKeyBody, licenseKeyHash } from '#licensing/keys'

/**
 * The pure core of licensing (licence plan §4, §5). Everything the license API
 * answers is decided by these functions, so each rule is pinned here on its
 * own.
 */
test.group('License keys', () => {
  test('have the product prefix and four groups of five', ({ assert }) => {
    const { key, suffix } = generateLicenseKey('wipro')

    assert.match(key, /^WIPRO-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/)
    assert.equal(suffix, key.slice(-4))
  })

  test('never repeat', ({ assert }) => {
    const hashes = new Set(Array.from({ length: 5_000 }, () => generateLicenseKey('X').hash))
    assert.equal(hashes.size, 5_000)
  })

  test('hash to the same value however they are typed', ({ assert }) => {
    const { key, hash } = generateLicenseKey('WIPRO')
    const body = key.split('-').slice(1).join('')

    for (const typed of [
      key,
      key.toLowerCase(),
      `  ${key}\n`,
      key.replace(/-/g, ''),
      key.replace(/-/g, ' '),
      body,
      `WIPRO${body}`,
    ]) {
      assert.equal(licenseKeyHash(typed), hash, JSON.stringify(typed))
    }
  })

  /**
   * Crockford decoding: O reads as 0, I and L as 1 — the mistakes people make
   * reading a key off a screen. Applied to the body only, never the prefix.
   */
  test('forgive look-alike letters in the body but not the prefix', ({ assert }) => {
    assert.equal(licenseKeyBody('WIPRO-O0000-00000-00000-0000I'), '00000000000000000001')
    assert.equal(licenseKeyBody('WIPRO-L1111-11111-11111-11111'), '11111111111111111111')
  })

  test('refuse anything that cannot be a key', ({ assert }) => {
    for (const bad of [
      null,
      undefined,
      42,
      '',
      'short',
      'WIPRO-UUUUU-UUUUU-UUUUU-UUUUU',
      'x'.repeat(200),
    ]) {
      assert.isNull(licenseKeyHash(bad), String(bad))
    }
  })
})

test.group('License validation', () => {
  const now = Date.UTC(2026, 8, 25)
  const facts = (overrides: Partial<LicenseFacts> = {}): LicenseFacts => ({
    status: 'active',
    expiresAtMs: null,
    productSlug: 'invoice-pro',
    subscriptionStatus: null,
    ...overrides,
  })
  const check = (license: LicenseFacts | null, extra: object = {}) =>
    evaluateLicense(license, { productSlug: 'invoice-pro', nowMs: now, ...extra })

  test('an active perpetual license is valid', ({ assert }) => {
    assert.deepEqual(check(facts()), { valid: true, reason: null })
  })

  test('each rule has its reason', ({ assert }) => {
    const cases: [LicenseFacts | null, object, string][] = [
      [null, {}, 'invalid_license'],
      [facts({ productSlug: 'other' }), {}, 'product_mismatch'],
      [facts({ status: 'revoked' }), {}, 'license_revoked'],
      [facts({ status: 'suspended' }), {}, 'license_suspended'],
      [facts({ expiresAtMs: now - 1 }), {}, 'license_expired'],
      [facts({ subscriptionStatus: 'canceled' }), {}, 'subscription_inactive'],
      [facts(), { requireActivation: { isActivated: false } }, 'not_activated'],
    ]

    for (const [license, extra, reason] of cases) {
      assert.deepEqual(check(license, extra), { valid: false, reason } as any, reason)
    }
  })

  test('expiry is exclusive of the expiry instant', ({ assert }) => {
    assert.isFalse(check(facts({ expiresAtMs: now })).valid)
    assert.isTrue(check(facts({ expiresAtMs: now + 1 })).valid)
  })

  /**
   * A failed card starts dunning; it does not switch the software off.
   */
  test('trialing, active and past-due subscriptions keep a license valid', ({ assert }) => {
    for (const status of ['trialing', 'active', 'past_due']) {
      assert.isTrue(check(facts({ subscriptionStatus: status })).valid, status)
    }
    for (const status of ['paused', 'canceled', 'expired']) {
      assert.isFalse(check(facts({ subscriptionStatus: status })).valid, status)
    }
  })

  /**
   * First failure wins, in the order of the public reason list — a revoked
   * license that has also expired says it was revoked.
   */
  test('reports the first failing rule', ({ assert }) => {
    const result = check(
      facts({ status: 'revoked', expiresAtMs: now - 1, subscriptionStatus: 'canceled' })
    )
    assert.equal(result.reason, 'license_revoked')
  })

  test('an activated instance passes the activation check', ({ assert }) => {
    assert.isTrue(check(facts(), { requireActivation: { isActivated: true } }).valid)
  })

  /**
   * The reason codes are compiled into shipped software. This list changing
   * is a breaking API change and should fail loudly here first.
   */
  test('the public reason codes are exactly these', ({ assert }) => {
    assert.deepEqual(
      [...LICENSE_REASONS],
      [
        'invalid_license',
        'product_mismatch',
        'license_revoked',
        'license_suspended',
        'license_expired',
        'subscription_inactive',
        'not_activated',
        'activation_limit_reached',
      ]
    )
  })
})

test.group('Hostnames', () => {
  test('normalise a site URL to its hostname', ({ assert }) => {
    const cases: [unknown, string | null][] = [
      ['https://www.Example.com/shop?x=1', 'example.com'],
      ['http://example.com:8080', 'example.com'],
      ['example.com', 'example.com'],
      ['EXAMPLE.COM.', 'example.com'],
      ['http://[::1]:3000', '::1'],
      ['', null],
      [null, null],
      ['http://', null],
    ]

    for (const [input, expected] of cases) {
      assert.strictEqual(normalizeHostname(input), expected, String(input))
    }
  })

  test('recognise development and staging installs', ({ assert }) => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      'shop.local',
      'mysite.test',
      'staging.example.com',
      'dev.example.com',
      'client.wpengine.com',
      'site.ddev.site',
    ]) {
      assert.isTrue(isDevHostname(host), host)
    }

    for (const host of ['example.com', 'developer.com', 'mystaging.com', 'local.com', null]) {
      assert.isFalse(isDevHostname(host), String(host))
    }
  })
})

test.group('Response signing', () => {
  test('round-trips a payload', ({ assert }) => {
    const envelope = signer.sign({ valid: true, reason: null, n: 'ü/✓' })

    assert.equal(envelope.alg, 'Ed25519')
    assert.deepEqual(signer.verify(envelope), { valid: true, reason: null, n: 'ü/✓' })
  })

  test('rejects a tampered payload or signature', ({ assert }) => {
    const envelope = signer.sign({ valid: false, reason: 'license_expired' })
    const forged = Buffer.from(JSON.stringify({ valid: true, reason: null })).toString('base64url')

    assert.isNull(signer.verify({ ...envelope, payload: forged }))
    assert.isNull(signer.verify({ ...envelope, signature: Buffer.alloc(64).toString('base64url') }))
    assert.isNull(signer.verify({ ...envelope, kid: 'someone-else' }))
  })

  test('publishes the raw 32-byte public key', ({ assert }) => {
    const [key] = signer.publishedKeys()

    assert.equal(key.kid, signer.keyId)
    assert.equal(Buffer.from(key.public_key, 'base64url').length, 32)
  })
})
