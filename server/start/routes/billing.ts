/*
|--------------------------------------------------------------------------
| Billing routes
|--------------------------------------------------------------------------
|
| Two groups with nothing in common but a prefix.
|
| The screens are owner-only and behind the full session stack: billing is
| the one area where a member should not even see the page, so the coarse
| gate is middleware rather than a policy on each action (plan §6).
|
| The webhook has no session at all. Its authentication is the signature over
| the raw body, and it is CSRF-exempt in `config/shield.ts` for the same
| reason — there is no browser on the other end of it.
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'
import { controllers } from '#generated/controllers'

router
  .group(() => {
    router.get('/billing', [controllers.billing.Billing, 'index']).as('billing.index')
    router.post('/billing/portal', [controllers.billing.Billing, 'portal']).as('billing.portal')

    /**
     * API keys sit in this owner-only group rather than with the tenant
     * screens (plan §6): a key can spend the organisation's whole monthly
     * call allowance and can be granted write access to everything, which
     * makes it billing-adjacent rather than a member-level setting.
     */
    router.get('/settings/api-keys', [controllers.apiKeys.ApiKey, 'index']).as('api_keys.index')
    router.post('/settings/api-keys', [controllers.apiKeys.ApiKey, 'store']).as('api_keys.store')
    router
      .post('/settings/api-keys/:id/revoke', [controllers.apiKeys.ApiKey, 'destroy'])
      .as('api_keys.destroy')
  })
  .use([
    middleware.auth(),
    middleware.verifiedEmail(),
    middleware.organization(),
    middleware.owner(),
  ])

/**
 * No middleware. Adding `auth` here would 401 every delivery.
 */
router.post('/webhooks/creem', [controllers.billing.Webhook, 'creem']).as('webhooks.creem')
