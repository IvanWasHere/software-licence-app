/*
|--------------------------------------------------------------------------
| Public license API — /api/v1 (licence plan §6)
|--------------------------------------------------------------------------
|
| What customers' software calls. It is a separate group from the
| organisation API in `start/routes/api.ts` on purpose, and the two must not
| be mixed:
|
|   organisation API — an `sk_live_` key, scoped to one workspace, called
|                      from servers we or our customers control.
|   license API      — product slug + license key, no API key, no session,
|                      called from plugins and apps on machines we will
|                      never see.
|
| Middleware, outermost first:
|
|   licenseApi                 — CORS for any origin, a request id, no-store,
|                                and the answer to a browser's preflight.
|   licenseApiAddressThrottle  — per address, generous (shared hosting).
|   licenseApiKeyThrottle      — per license key, on the POSTs that carry one.
|
| `/webhooks/*` and `/api/*` are CSRF-exempt in `config/shield.ts`; nothing
| here reads a cookie, which is what makes the open CORS policy safe.
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'
import { controllers } from '#generated/controllers'
import { publicIdMatcher } from '#models/public_id'
import { licenseApiAddressThrottle, licenseApiKeyThrottle } from '#start/limiter'

router
  .group(() => {
    router
      .post('/licenses/validate', [controllers.api.v1.License, 'validate'])
      .as('license_api.validate')
      .use(licenseApiKeyThrottle)
    router
      .post('/licenses/activate', [controllers.api.v1.License, 'activate'])
      .as('license_api.activate')
      .use(licenseApiKeyThrottle)
    router
      .post('/licenses/deactivate', [controllers.api.v1.License, 'deactivate'])
      .as('license_api.deactivate')
      .use(licenseApiKeyThrottle)

    router
      .route('/licenses/*', ['OPTIONS'], [controllers.api.v1.License, 'preflight'])
      .as('license_api.preflight')

    router.get('/products/:slug', [controllers.api.v1.Product, 'show']).as('license_api.product')
    router
      .get('/products/:slug/releases/latest', [controllers.api.v1.Release, 'latest'])
      .as('license_api.releases.latest')
    router
      .get('/releases/:id/download', [controllers.api.v1.Release, 'download'])
      .as('license_api.release_download')
      .where('id', publicIdMatcher('release'))

    router.get('/keys', [controllers.api.v1.License, 'keys']).as('license_api.keys')
  })
  .prefix('/api/v1')
  .use([middleware.licenseApi(), licenseApiAddressThrottle])
