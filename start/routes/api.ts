/*
|--------------------------------------------------------------------------
| Organisation API — /api/v1 (plan §11)
|--------------------------------------------------------------------------
|
| JSON only, versioned by URL segment, authenticated by an organisation API
| key. **The key is the scope**: no route here accepts an organisation id, so
| there is nothing for a caller to forge and no endpoint that can be pointed
| at another tenant.
|
| Middleware order is deliberate:
|
|   trackApiUsage  — outermost, so a 401 or a 402 is recorded too. Those are
|                    exactly the responses somebody asks support about.
|   apiKeyAuth     — authenticates and puts the organisation on the context.
|   apiRateLimit   — needs the key, so it runs after auth.
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'
import { controllers } from '#generated/controllers'
import { publicIdMatcher } from '#models/public_id'

router
  .group(() => {
    router
      .get('/organization', [controllers.api.v1.Organization, 'show'])
      .as('api.organization.show')
    router.get('/members', [controllers.api.v1.Organization, 'members']).as('api.members.index')

    /**
     * A customer's own licenses (licence plan M5). The id matcher keeps
     * `/licenses/validate` and friends — the keyless license API — from ever
     * being read as an id here.
     */
    router.get('/licenses', [controllers.api.v1.AccountLicense, 'index']).as('api.licenses.index')
    router
      .get('/licenses/:id', [controllers.api.v1.AccountLicense, 'show'])
      .as('api.licenses.show')
      .where('id', publicIdMatcher('license'))

    /**
     * The integration API (licence plan §6, M4) — our own website's backend
     * selling and looking customers up. Only the system account's key gets
     * in; see `RequireSystemOrganizationMiddleware`.
     */
    router
      .group(() => {
        router.post('/checkout', [controllers.api.v1.Integration, 'checkout']).as('api.checkout')
        router.get('/orders/:id', [controllers.api.v1.Integration, 'order']).as('api.orders.show')
        router
          .get('/customers/licenses', [controllers.api.v1.Integration, 'customerLicenses'])
          .as('api.customers.licenses')
      })
      .use(middleware.systemOrganization())
  })
  .prefix('/api/v1')
  .use([middleware.trackApiUsage(), middleware.apiKeyAuth(), middleware.apiRateLimit()])
