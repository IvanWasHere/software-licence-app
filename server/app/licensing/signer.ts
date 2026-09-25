import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'

import licensingConfig from '#config/licensing'

/**
 * Signing license API responses (licence plan §5.2).
 *
 * An SDK caches the last good answer so the software keeps working through an
 * outage (§7). A cache is a file on the customer's machine, and so is the
 * hosts file that could point our domain at a fake server — so neither is
 * trusted unless it carries our signature.
 *
 * **What is signed is the exact bytes of the payload**, carried base64url
 * encoded next to the signature. The alternative — signing a canonical JSON
 * form of the parsed object — needs the JS and PHP SDKs to re-serialise JSON
 * byte-identically, and they do not agree on unicode or slash escaping. With
 * the bytes in hand, a client verifies and then parses exactly what was
 * signed.
 */

export interface SignedEnvelope {
  alg: 'Ed25519'
  kid: string
  payload: string
  signature: string
}

export interface PublishedKey {
  kid: string
  alg: 'Ed25519'

  /**
   * The raw 32-byte public key, base64url — the form WebCrypto and libsodium
   * both take directly.
   */
  public_key: string
}

export class ResponseSigner {
  #privateKey: KeyObject | null = null
  #publicKey: KeyObject | null = null

  get keyId(): string {
    return licensingConfig.signingKeyId
  }

  sign(payload: unknown): SignedEnvelope {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8')

    return {
      alg: 'Ed25519',
      kid: this.keyId,
      payload: bytes.toString('base64url'),
      signature: sign(null, bytes, this.privateKey()).toString('base64url'),
    }
  }

  /**
   * The parsed payload when the signature holds, `null` otherwise. What the
   * SDKs do, here so the tests can prove a round trip and a tamper.
   */
  verify(envelope: SignedEnvelope): unknown | null {
    if (envelope.alg !== 'Ed25519' || envelope.kid !== this.keyId) {
      return null
    }

    const bytes = Buffer.from(envelope.payload, 'base64url')
    const ok = verify(null, bytes, this.publicKey(), Buffer.from(envelope.signature, 'base64url'))

    return ok ? JSON.parse(bytes.toString('utf8')) : null
  }

  publishedKeys(): PublishedKey[] {
    const jwk = this.publicKey().export({ format: 'jwk' })

    return [{ kid: this.keyId, alg: 'Ed25519', public_key: jwk.x! }]
  }

  private privateKey(): KeyObject {
    if (!this.#privateKey) {
      this.#privateKey = this.loadPrivateKey()
    }

    return this.#privateKey
  }

  private publicKey(): KeyObject {
    if (!this.#publicKey) {
      this.#publicKey = createPublicKey(this.privateKey())
    }

    return this.#publicKey
  }

  /**
   * Read lazily rather than at import, so a process that never signs — a
   * worker, a migration — boots without the key.
   */
  private loadPrivateKey(): KeyObject {
    const configured = licensingConfig.signingKey?.release()

    if (configured) {
      const key = createPrivateKey({
        key: Buffer.from(configured, 'base64'),
        format: 'der',
        type: 'pkcs8',
      })

      if (key.asymmetricKeyType !== 'ed25519') {
        throw new Error('LICENSE_SIGNING_KEY must be an Ed25519 private key')
      }

      return key
    }

    if (app.inProduction) {
      throw new Error(
        'LICENSE_SIGNING_KEY is not set. Generate one with `node ace licensing:keygen`.'
      )
    }

    if (!app.inTest) {
      logger.warn(
        'LICENSE_SIGNING_KEY is not set; signing with a key that lasts until this process exits'
      )
    }

    return generateKeyPairSync('ed25519').privateKey
  }
}

export default new ResponseSigner()
