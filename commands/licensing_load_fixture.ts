import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Data for the license API load test (licence plan M8, `scripts/load`):
 * one product, N activated licenses, and a JSON file of their keys and
 * installation ids for the load generator to replay.
 *
 * Refuses to run in production — it creates licenses nobody paid for.
 */
export default class LicensingLoadFixture extends BaseCommand {
  static commandName = 'licensing:load-fixture'
  static description =
    'Create activated licenses for the license API load test (never in production)'
  static options: CommandOptions = { startApp: true }

  @flags.number({ description: 'How many licenses', default: 500 })
  declare licenses: number

  @flags.string({ description: 'Where to write the keys', default: 'tmp/load-fixture.json' })
  declare out: string

  async run() {
    if (this.app.inProduction) {
      this.logger.error('This creates free licenses. It does not run in production.')
      this.exitCode = 1
      return
    }

    const { default: catalog } = await import('#catalog/catalog_service')
    const { default: licenses, SYSTEM_ACTOR } = await import('#licensing/license_service')
    const { default: activations } = await import('#licensing/activation_service')
    const { default: registration } = await import('#auth/registration_service')

    const slug = `load-test-${Date.now().toString(36)}`
    const product = await catalog.createProduct({
      name: 'Load test',
      slug,
      kind: 'wordpress_plugin',
      keyPrefix: 'LOAD',
      validationIntervalHours: 24,
      offlineGraceDays: 7,
      countDevSites: false,
    })
    product.status = 'active'
    await product.save()

    const plan = await catalog.createPlan(product, {
      name: 'Load',
      slug: 'load',
      billing: 'one_time',
      priceCents: 100,
      currency: 'EUR',
      licenseTerm: 'perpetual',
      maxActivations: 3,
      isPublic: false,
    })

    const { organization } = await registration.register({
      fullName: 'Load Test',
      email: `${slug}@example.com`,
      password: `pw-${slug}-${Math.random()}`,
    })

    const fixture: { key: string; instance_id: string }[] = []

    for (let i = 0; i < this.licenses; i++) {
      const { license, key } = await licenses.issue({
        organization,
        plan,
        source: 'manual',
        actor: SYSTEM_ACTOR,
      })
      await license.load('product')
      const instanceId = `load-${i}`
      await activations.activate(
        license,
        { instanceId, siteUrl: `https://site-${i}.example.com` },
        SYSTEM_ACTOR
      )
      fixture.push({ key, instance_id: instanceId })
    }

    await mkdir(dirname(this.out), { recursive: true })
    await writeFile(this.out, JSON.stringify({ product: slug, licenses: fixture }))

    this.logger.success(`${fixture.length} activated licenses for ${slug} → ${this.out}`)
  }
}
