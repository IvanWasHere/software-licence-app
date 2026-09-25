import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Mints an API key for the integration API (licence plan §6, M4) — the key
 * our own website backend uses to start checkouts and look up orders. The
 * key belongs to the system organisation, created on first run (see
 * `#commerce/integration_keys`).
 *
 * Prints the key once. Run it again for a second key (rotation); revoke old
 * ones from the back-office.
 */
export default class LicensingIntegrationKey extends BaseCommand {
  static commandName = 'licensing:integration-key'
  static description = 'Create an API key for the integration API (checkout, orders)'

  static options: CommandOptions = {
    startApp: true,
  }

  @flags.string({ description: 'A name to recognise the key by', default: 'Website backend' })
  declare name: string

  async run() {
    const { default: integrationKeys } = await import('#commerce/integration_keys')
    const { organization, secret } = await integrationKeys.create(this.name)

    this.logger.success(`Integration key created for ${organization.publicId}. It is shown once:`)
    this.logger.log(secret)
  }
}
