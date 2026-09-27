import env from '#start/env'

/**
 * Licensing (licence plan §5).
 */
const licensingConfig = {
  /**
   * The Ed25519 key validate responses are signed with (§5.2), as base64 of
   * the PKCS#8 DER private key. `node ace licensing:keygen` prints one.
   *
   * Required in production — an unsigned response is one a fake local server
   * can forge. Outside production an ephemeral key is generated per process,
   * which is enough for development and the test suite and useless to anyone
   * trying to rely on it.
   */
  signingKey: env.get('LICENSE_SIGNING_KEY'),

  /**
   * Published beside each signature so clients can hold several public keys
   * across a rotation (§9).
   */
  signingKeyId: env.get('LICENSE_SIGNING_KEY_ID') ?? 'k1',

  /**
   * Public keys published on `/keys` beside the active one, for a rotation
   * (docs/runbooks.md): the *next* key, announced before the switch so SDK
   * builds can pin it, and the *previous* one for a while after.
   * `kid:base64url,kid:base64url`. They sign nothing.
   */
  extraPublicKeys: env.get('LICENSE_SIGNING_EXTRA_PUBLIC_KEYS', ''),

  /**
   * Hostnames treated as development or staging installs (§5.4). They are
   * marked `is_dev` and count toward the activation limit like any other
   * site, unless a product is set not to count them. A leading `*.` matches
   * any subdomain; a trailing `.*` matches a first label, e.g. `staging.*` is
   * `staging.example.com`.
   */
  devHostPatterns: [
    'localhost',
    '127.0.0.1',
    '::1',
    '*.localhost',
    '*.local',
    '*.test',
    '*.example',
    '*.invalid',
    '*.ddev.site',
    '*.lndo.site',
    'dev.*',
    'staging.*',
    'stage.*',
    'test.*',
    '*.wpengine.com',
    '*.wpenginepowered.com',
    '*.kinsta.cloud',
    '*.flywheelsites.com',
    '*.pantheonsite.io',
  ],

  /**
   * `last_seen_at` is written at most this often per activation — it is
   * worth knowing, and not worth a write on every validate call.
   */
  heartbeatThrottleMinutes: 60,

  /**
   * How long a subscription license outlives the paid period (licence plan
   * §5.3). A renewal that succeeds moves the expiry on; one that keeps
   * failing simply lets the license lapse this many days after the period
   * ended. This *is* the dunning window — there is no job that suspends
   * anybody, the expiry does it.
   */
  renewalGraceDays: 30,

  /**
   * Days before a license that will not renew by itself expires on which its
   * owner is emailed (licence plan §5.5). Each is sent once per expiry date.
   */
  expiryReminderDays: [14, 3],

  /**
   * When the abuse job flags a license for a human to look at (licence plan
   * §9, M8). Nothing is revoked automatically; these only decide what is
   * worth a look. Allowances scale with the license's size — an agency
   * license on 50 sites is not suspicious for being busy.
   */
  abuse: {
    /** Distinct addresses in one day: at least this many are always fine… */
    ipsPerDayFloor: 20,
    /** …and a license may have this many per activation slot (or live activation). */
    ipsPerDayPerSlot: 3,
    /** New activations in 24 hours: at least this many are always fine… */
    activationsPerDayFloor: 10,
    /** …and this many per slot — churning installs is how a shared key looks. */
    activationsPerDayPerSlot: 2,
    /** Live development/staging activations, which do not count toward the limit. */
    devSites: 25,
    /** How long address sightings are kept. */
    ipRetentionDays: 30,
  },
}

export default licensingConfig
