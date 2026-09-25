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
   * Hostnames treated as development or staging installs (§5.4). They do not
   * count toward a plan's activation limit unless the product says they
   * should. A leading `*.` matches any subdomain; a trailing `.*` matches a
   * first label, e.g. `staging.*` is `staging.example.com`.
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
}

export default licensingConfig
