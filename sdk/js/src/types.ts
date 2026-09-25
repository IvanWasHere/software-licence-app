/**
 * Why a license is not valid. The first eight come from the server and are
 * permanent; the last three are the SDK's own.
 */
export type LicenseReason =
  | 'invalid_license'
  | 'product_mismatch'
  | 'license_revoked'
  | 'license_suspended'
  | 'license_expired'
  | 'subscription_inactive'
  | 'not_activated'
  | 'activation_limit_reached'
  /** No key has been entered on this installation yet. */
  | 'no_license_key'
  /** The server has not been reachable for longer than the product allows. */
  | 'offline_grace_expired'
  /** An answer arrived that did not verify — treated like no answer at all. */
  | 'untrusted_response'

export type EntitlementValue = boolean | number | string

export interface LicenseInfo {
  id: string
  status: 'active' | 'suspended' | 'revoked'
  type: 'perpetual' | 'subscription' | 'fixed_days'
  expires_at: string | null
  updates_until: string | null
  product: string
  plan: string
  key_suffix: string
  activations: { used: number; max: number | null }
}

export interface ActivationInfo {
  id: string
  instance_id: string
  hostname: string | null
  is_dev: boolean
  activated_at: string | null
}

export interface ClientPolicy {
  validation_interval_hours: number
  offline_grace_days: number
}

/**
 * The signed part of every license API answer, as the server sent it.
 */
export interface LicensePayload {
  valid?: boolean
  activated?: boolean
  deactivated?: boolean
  reason: LicenseReason | null
  license?: LicenseInfo | null
  activation?: ActivationInfo | null
  entitlements?: Record<string, EntitlementValue>
  policy?: ClientPolicy
  product: string
  instance_id: string | null
  nonce: string | null
  checked_at: string
  request_id: string
}

export interface SignedEnvelope {
  alg: 'Ed25519'
  kid: string
  payload: string
  signature: string
}

/**
 * What the SDK reports. Everything here comes from a verified answer — the
 * network one, the cached one, or (offline) the last good one.
 */
export interface LicenseState {
  valid: boolean
  reason: LicenseReason | null

  /**
   * `network` — just asked the server. `cache` — a recent answer, reused.
   * `offline` — the server could not be reached; this is the last good answer,
   * still inside the offline grace.
   */
  source: 'network' | 'cache' | 'offline' | 'none'
  offline: boolean

  license: LicenseInfo | null
  activation: ActivationInfo | null
  entitlements: Record<string, EntitlementValue>
  policy: ClientPolicy

  /** When the answer this state is built from was given by the server. */
  checkedAt: Date | null
}

/**
 * Where the SDK keeps its one record per product: the key, this
 * installation's id and the last verified answers. Sync or async.
 */
export interface LicenseStorage {
  get(key: string): string | null | undefined | Promise<string | null | undefined>
  set(key: string, value: string): void | Promise<void>
  remove(key: string): void | Promise<void>
}

/**
 * Verifies an Ed25519 signature. The default uses WebCrypto; pass your own for
 * a runtime that lacks Ed25519 there.
 */
export type SignatureVerifier = (
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array
) => Promise<boolean>
