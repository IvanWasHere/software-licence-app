import { promisify } from 'node:util'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'

import env from '#start/env'
import signer from '#licensing/signer'
import catalog from '#catalog/catalog_service'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'
import { clearStorage, createLicense, createRelease } from '#tests/helpers'

/**
 * The PHP contract test (licence plan §7.2, M7): the real PHP client against
 * the real server, over HTTP — activation, validation, entitlements, the
 * update check and the download it links to. The PHP suite proves the
 * client's logic against a fake; this proves the fake and the server agree.
 *
 * Skipped where there is no PHP with sodium. CI installs it.
 */
const run = promisify(execFile)

function phpAvailable(): boolean {
  try {
    return (
      execFileSync('php', ['-r', 'echo extension_loaded("sodium") ? "yes" : "no";'], {
        encoding: 'utf8',
      }) === 'yes'
    )
  } catch {
    return false
  }
}

const hasPhp = phpAvailable()

test.group('PHP SDK — against the server', (group) => {
  group.each.setup(async () => {
    await clearStorage()
    return testUtils.db().truncate()
  })

  const baseUrl = `http://${env.get('HOST')}:${env.get('PORT')}/api/v1`

  /**
   * Asynchronous on purpose: the server answering the script runs in this
   * process, and a synchronous spawn would block it.
   */
  async function php(input: {
    product: string
    key: string
    steps: string[]
    entitlement?: string
    storage?: string
  }) {
    const [{ kid, public_key: publicKey }] = signer.publishedKeys()
    const storage = input.storage ?? join(await mkdtemp(join(tmpdir(), 'php-sdk-')), 'license.json')

    const { stdout } = await run(
      'php',
      [
        app.makePath('sdk/php/tests/contract/run.php'),
        JSON.stringify({ base_url: baseUrl, public_key: { [kid]: publicKey }, storage, ...input }),
      ],
      { timeout: 30_000 }
    )

    return JSON.parse(stdout)
  }

  test('activates, validates and reads entitlements', async ({ assert }) => {
    const { key, product, plan } = await createLicense()
    await catalog.createEntitlement(product, { key: 'pdf_export', name: 'PDF', type: 'boolean' })
    await catalog.setPlanEntitlements(product, plan, { pdf_export: '1' })

    const out = await php({
      product: product.slug,
      key,
      steps: ['activate', 'validate', 'has'],
      entitlement: 'pdf_export',
    })

    assert.isUndefined(out.error)
    assert.isTrue(out.activate.valid)
    assert.equal(out.activate.activation.hostname, 'wp.example.com')
    assert.isTrue(out.validate.valid)
    assert.equal(out.validate.source, 'network')
    assert.equal(out.validate.license.product, product.slug)
    assert.equal(out.validate.policy.offline_grace_days, 7)
    assert.isTrue(out.has)
  })
    .skip(!hasPhp, 'php with sodium is not installed')
    .timeout(40_000)

  test('hears a revocation as the reason code the server sends', async ({ assert }) => {
    const { key, product, license } = await createLicense()
    const storage = join(await mkdtemp(join(tmpdir(), 'php-sdk-')), 'license.json')
    await php({ product: product.slug, key, steps: ['activate'], storage })

    await licenses.revoke(license, 'refund', SYSTEM_ACTOR)
    const out = await php({ product: product.slug, key, steps: ['validate'], storage })

    assert.isFalse(out.validate.valid)
    assert.equal(out.validate.reason, 'license_revoked')
  })
    .skip(!hasPhp, 'php with sodium is not installed')
    .timeout(40_000)

  test('gets the update, downloads it, and the bytes match the signed checksum', async ({
    assert,
  }) => {
    const { key, product } = await createLicense()
    product.status = 'active'
    await product.save()
    const release = await createRelease(product, { version: '1.4.0' })

    const out = await php({ product: product.slug, key, steps: ['activate', 'latest'] })

    assert.equal(out.latest.release.version, '1.4.0')
    assert.equal(out.latest.release.checksum_sha256, release.checksum)
    assert.isTrue(out.latest.update_allowed)
    assert.equal(out.download.status, 200)
    assert.isTrue(out.download.matches_signed_checksum)
  })
    .skip(!hasPhp, 'php with sodium is not installed')
    .timeout(40_000)

  test('an unknown key is a state, and deactivating frees the slot', async ({ assert }) => {
    const { key, product, license } = await createLicense()

    const refused = await php({
      product: product.slug,
      key: 'WIPRO-NOPE0-NOPE0-NOPE0-NOPE0',
      steps: ['activate'],
    })
    assert.isFalse(refused.activate.valid)
    assert.equal(refused.activate.reason, 'invalid_license')

    const out = await php({ product: product.slug, key, steps: ['activate', 'deactivate'] })
    assert.isTrue(out.deactivate)

    await license.load('activations')
    assert.isTrue(license.activations.every((activation) => activation.deactivatedAt !== null))
  })
    .skip(!hasPhp, 'php with sodium is not installed')
    .timeout(40_000)
})
