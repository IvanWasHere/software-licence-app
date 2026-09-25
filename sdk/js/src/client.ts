import { randomId } from './encoding.js'
import { localStorageOrMemory } from './storage.js'
import { openEnvelope, webCryptoVerifier } from './signature.js'
import type {
  ClientPolicy,
  EntitlementValue,
  LicensePayload,
  LicenseState,
  LicenseStorage,
  SignatureVerifier,
  SignedEnvelope,
} from './types.js'

export interface LicenseClientOptions {
  /** The license API, e.g. `https://licenses.example.com/api/v1`. */
  baseUrl: string

  /** The product slug this software is licensed as. */
  product: string

  /**
   * The server's response-signing public key(s), base64url of the raw 32
   * bytes, from `GET /api/v1/keys`. Pin them in your build: fetching them at
   * runtime would let whoever answers that request vouch for themselves.
   * A single string is accepted for any `kid`; a map pins keys by `kid`, which
   * is what carries you across a key rotation.
   */
  publicKey: string | Record<string, string>

  /** Where the key and the last answers are kept. Default: localStorage, else memory. */
  storage?: LicenseStorage

  /** An installation id you already have. Default: generated once and stored. */
  instanceId?: string

  /** Reported on activation, so the account shows which version runs where. */
  clientVersion?: string

  /** Injectable for tests and unusual runtimes. */
  fetch?: typeof fetch
  now?: () => number
  verify?: SignatureVerifier

  /** How long a "not valid" answer is reused before asking again. Default 60 minutes. */
  invalidCacheMinutes?: number

  /** Called whenever validity or the reason changes. */
  onChange?: (state: LicenseState) => void
}

export interface ActivateOptions {
  siteUrl?: string
  label?: string
}

export class LicenseSdkError extends Error {
  readonly code: 'network' | 'rejected_request' | 'untrusted_response'

  constructor(message: string, code: LicenseSdkError['code']) {
    super(message)
    this.name = 'LicenseSdkError'
    this.code = code
  }
}

interface StoredRecord {
  v: 1
  licenseKey: string | null
  instanceId: string
  /** The last verified answer, valid or not. */
  answer: SignedEnvelope | null
  /** The last verified answer that said valid — what offline grace falls back on. */
  lastGood: SignedEnvelope | null
}

const DEFAULT_POLICY: ClientPolicy = { validation_interval_hours: 24, offline_grace_days: 7 }
const HOUR = 3_600_000

/**
 * A license client for one product on one installation (licence plan §7).
 *
 * The contract, in order:
 * 1. A cached answer younger than the product's `validation_interval_hours`
 *    is reused; a "no" is reused for an hour.
 * 2. Otherwise the server is asked, with a fresh nonce. The answer counts only
 *    if its signature verifies and it echoes this request's nonce, product and
 *    installation.
 * 3. If the server cannot be reached, the last good answer stands, marked
 *    `offline`, while it is younger than `offline_grace_days`; after that the
 *    state is `offline_grace_expired`.
 * 4. It never switches anything off by itself. It reports; the software
 *    decides what to lock.
 *
 * Every age is measured from the signed `checked_at`, never from anything
 * stored beside it, so an edited cache cannot make an old answer look fresh.
 */
export class LicenseClient {
  #options: LicenseClientOptions
  #storage: LicenseStorage
  #fetch: typeof fetch
  #now: () => number
  #verify: SignatureVerifier
  #keys: Record<string, string>
  #storageKey: string
  #state: LicenseState

  constructor(options: LicenseClientOptions) {
    if (!options.baseUrl || !options.product || !options.publicKey) {
      throw new TypeError('baseUrl, product and publicKey are required')
    }

    this.#options = options
    this.#storage = options.storage ?? localStorageOrMemory()
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#now = options.now ?? Date.now
    this.#verify = options.verify ?? webCryptoVerifier
    this.#keys =
      typeof options.publicKey === 'string' ? { '*': options.publicKey } : options.publicKey
    this.#storageKey = `licence-app:${options.product}`
    this.#state = emptyState('no_license_key')
  }

  /** The last state reported, without asking anybody. */
  get state(): LicenseState {
    return this.#state
  }

  /** Whether a boolean entitlement is on — or any other kind is set to something. */
  has(entitlement: string): boolean {
    const value = this.#state.valid ? this.#state.entitlements[entitlement] : undefined
    return value !== undefined && value !== false && value !== 0 && value !== ''
  }

  /** An entitlement's value, or `fallback` when the license is not valid or lacks it. */
  get<T extends EntitlementValue>(entitlement: string, fallback: T): T {
    const value = this.#state.valid ? this.#state.entitlements[entitlement] : undefined
    return value === undefined ? fallback : (value as T)
  }

  /**
   * Activate this installation with a key the customer typed. Throws only when
   * the server cannot be asked at all; a refusal (wrong key, no slots left) is
   * a state with a reason, and the key is then not remembered.
   */
  async activate(licenseKey: string, options: ActivateOptions = {}): Promise<LicenseState> {
    const record = await this.#load()
    const key = licenseKey.trim()

    const { payload, envelope, untrusted } = await this.#ask('activate', {
      license_key: key,
      instance_id: record.instanceId,
      site_url: options.siteUrl,
      label: options.label,
      client_version: this.#options.clientVersion,
    })

    if (!payload) {
      throw untrusted
        ? new LicenseSdkError(
            'The license server answered, but not with a signature this build trusts. Check the pinned public key.',
            'untrusted_response'
          )
        : new LicenseSdkError('The license server could not be reached', 'network')
    }

    if (payload.activated) {
      await this.#save({ ...record, licenseKey: key, answer: envelope, lastGood: envelope })
    }

    return this.#report(stateFrom(payload, 'network'))
  }

  /**
   * Is this installation licensed? Answers from the cache when it is fresh
   * enough, asks the server otherwise, and falls back to the last good answer
   * while offline. `force` skips the cache.
   */
  async validate(options: { force?: boolean } = {}): Promise<LicenseState> {
    const record = await this.#load()

    if (!record.licenseKey) {
      return this.#report(emptyState('no_license_key'))
    }

    const cached = await openEnvelope(record.answer, this.#keys, this.#verify)

    if (!options.force && cached && this.#isFresh(cached)) {
      return this.#report(stateFrom(cached, 'cache'))
    }

    const { payload, envelope, untrusted } = await this.#ask('validate', {
      license_key: record.licenseKey,
      instance_id: record.instanceId,
    })

    if (payload) {
      await this.#save({
        ...record,
        answer: envelope,
        lastGood: payload.valid ? envelope : record.lastGood,
      })

      return this.#report(stateFrom(payload, 'network'))
    }

    return this.#report(await this.#offline(record, untrusted))
  }

  /**
   * Release this installation's slot and forget the key here. The key is
   * forgotten even when the server cannot be reached — the customer asked to
   * remove it — and the slot can then be freed from their account.
   */
  async deactivate(): Promise<{ deactivated: boolean }> {
    const record = await this.#load()

    if (!record.licenseKey) {
      return { deactivated: false }
    }

    const { payload } = await this.#ask('deactivate', {
      license_key: record.licenseKey,
      instance_id: record.instanceId,
    })

    await this.#save({ ...record, licenseKey: null, answer: null, lastGood: null })
    this.#report(emptyState('no_license_key'))

    return { deactivated: Boolean(payload?.deactivated) }
  }

  /** The id this installation activates as. Generated and stored on first use. */
  async instanceId(): Promise<string> {
    const record = await this.#load()
    return record.instanceId
  }

  /**
   * One call to the license API. Returns the payload only when the answer is
   * signed by a pinned key and echoes the nonce, product and installation of
   * this request; anything else is `untrusted` and treated like no answer.
   */
  async #ask(
    action: 'activate' | 'validate' | 'deactivate',
    body: Record<string, string | undefined>
  ): Promise<{ payload: LicensePayload | null; envelope: SignedEnvelope | null; untrusted: boolean }> {
    const nonce = randomId().replace(/-/g, '')
    let response: Response

    try {
      response = await this.#fetch(`${this.#options.baseUrl.replace(/\/$/, '')}/licenses/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ product: this.#options.product, nonce, ...body }),
      })
    } catch {
      return { payload: null, envelope: null, untrusted: false }
    }

    if (response.status === 422) {
      throw new LicenseSdkError(
        `The license server refused the request: ${await response.text()}`,
        'rejected_request'
      )
    }

    if (!response.ok) {
      return { payload: null, envelope: null, untrusted: false }
    }

    let envelope: SignedEnvelope | null = null

    try {
      envelope = ((await response.json()) as { signed?: SignedEnvelope }).signed ?? null
    } catch {
      return { payload: null, envelope: null, untrusted: true }
    }

    const payload = await openEnvelope(envelope, this.#keys, this.#verify)

    const matches =
      payload &&
      payload.nonce === nonce &&
      payload.product === this.#options.product &&
      (payload.instance_id ?? null) === (body.instance_id ?? null)

    return matches
      ? { payload, envelope, untrusted: false }
      : { payload: null, envelope: null, untrusted: true }
  }

  async #offline(record: StoredRecord, untrusted: boolean): Promise<LicenseState> {
    const lastGood = await openEnvelope(record.lastGood, this.#keys, this.#verify)

    if (lastGood) {
      const graceMs = policyOf(lastGood).offline_grace_days * 24 * HOUR

      if (this.#ageOf(lastGood) < graceMs) {
        return { ...stateFrom(lastGood, 'offline'), offline: true }
      }
    }

    return {
      ...emptyState(untrusted ? 'untrusted_response' : 'offline_grace_expired'),
      source: 'offline',
      offline: true,
    }
  }

  #isFresh(payload: LicensePayload): boolean {
    const age = this.#ageOf(payload)

    if (age < 0) {
      return false
    }

    return payload.valid
      ? age < policyOf(payload).validation_interval_hours * HOUR
      : age < (this.#options.invalidCacheMinutes ?? 60) * 60_000
  }

  #ageOf(payload: LicensePayload): number {
    return this.#now() - Date.parse(payload.checked_at)
  }

  #report(state: LicenseState): LicenseState {
    const previous = this.#state
    this.#state = state

    if (previous.valid !== state.valid || previous.reason !== state.reason) {
      this.#options.onChange?.(state)
    }

    return state
  }

  async #load(): Promise<StoredRecord> {
    let record: StoredRecord | null = null

    try {
      const raw = await this.#storage.get(this.#storageKey)
      const parsed = raw ? (JSON.parse(raw) as StoredRecord) : null
      record = parsed?.v === 1 ? parsed : null
    } catch {
      record = null
    }

    if (record) {
      return record
    }

    const fresh: StoredRecord = {
      v: 1,
      licenseKey: null,
      instanceId: this.#options.instanceId ?? randomId(),
      answer: null,
      lastGood: null,
    }

    await this.#save(fresh)
    return fresh
  }

  async #save(record: StoredRecord): Promise<void> {
    await this.#storage.set(this.#storageKey, JSON.stringify(record))
  }
}

export function createLicenseClient(options: LicenseClientOptions): LicenseClient {
  return new LicenseClient(options)
}

function policyOf(payload: LicensePayload): ClientPolicy {
  return payload.policy ?? DEFAULT_POLICY
}

function stateFrom(payload: LicensePayload, source: LicenseState['source']): LicenseState {
  const valid = Boolean(payload.valid ?? payload.activated)

  return {
    valid,
    reason: payload.reason ?? null,
    source,
    offline: false,
    license: payload.license ?? null,
    activation: payload.activation ?? null,
    entitlements: valid ? (payload.entitlements ?? {}) : {},
    policy: policyOf(payload),
    checkedAt: new Date(payload.checked_at),
  }
}

function emptyState(reason: LicenseState['reason']): LicenseState {
  return {
    valid: false,
    reason,
    source: 'none',
    offline: false,
    license: null,
    activation: null,
    entitlements: {},
    policy: DEFAULT_POLICY,
    checkedAt: null,
  }
}
