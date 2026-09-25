import { generateKeyPairSync } from 'node:crypto'
import { BaseCommand } from '@adonisjs/core/ace'

/**
 * Prints a fresh Ed25519 key pair for signing license API responses (licence
 * plan §5.2). Nothing is written anywhere: the private half goes into the
 * deployment's secrets as `LICENSE_SIGNING_KEY`, and the public half is what
 * `/api/v1/keys` will publish and SDKs may pin.
 */
export default class LicensingKeygen extends BaseCommand {
  static commandName = 'licensing:keygen'
  static description = 'Generate an Ed25519 key pair for signing license responses'

  async run() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')

    const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    const publicRaw = publicKey.export({ format: 'jwk' }).x

    this.logger.info('Put these in the environment. The private key is shown once.')
    this.logger.log(`LICENSE_SIGNING_KEY=${privateDer}`)
    this.logger.log(`LICENSE_SIGNING_KEY_ID=k${Date.now().toString(36)}`)
    this.logger.log('')
    this.logger.log(`Public key (base64url, raw 32 bytes): ${publicRaw}`)
  }
}
