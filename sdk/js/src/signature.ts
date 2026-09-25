import { fromBase64Url } from './encoding.js'
import type { LicensePayload, SignatureVerifier, SignedEnvelope } from './types.js'

/**
 * The default verifier: WebCrypto's Ed25519, built into Node 20+, Deno, Bun
 * and current browsers.
 */
export const webCryptoVerifier: SignatureVerifier = async (publicKey, signature, message) => {
  /**
   * `slice()` hands WebCrypto plain ArrayBuffer-backed copies, which every
   * runtime's typings accept.
   */
  const key = await crypto.subtle.importKey('raw', publicKey.slice(), 'Ed25519', false, ['verify'])

  return crypto.subtle.verify('Ed25519', key, signature.slice(), message.slice())
}

/**
 * The payload of a signed answer if — and only if — its signature verifies
 * under one of the pinned keys. Everything the SDK believes goes through here,
 * including what it reads back from its own storage.
 */
export async function openEnvelope(
  envelope: SignedEnvelope | null | undefined,
  publicKeys: Record<string, string>,
  verify: SignatureVerifier
): Promise<LicensePayload | null> {
  if (!envelope || envelope.alg !== 'Ed25519' || typeof envelope.payload !== 'string') {
    return null
  }

  const publicKey = publicKeys[envelope.kid] ?? publicKeys['*']

  if (!publicKey) {
    return null
  }

  try {
    const bytes = fromBase64Url(envelope.payload)
    const ok = await verify(fromBase64Url(publicKey), fromBase64Url(envelope.signature), bytes)

    return ok ? (JSON.parse(new TextDecoder().decode(bytes)) as LicensePayload) : null
  } catch {
    return null
  }
}
