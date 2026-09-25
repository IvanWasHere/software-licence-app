/*
|--------------------------------------------------------------------------
| The organisation API's surface
|--------------------------------------------------------------------------
|
| Every scope a key can hold and every endpoint the published spec describes
| (plan §11).
|
| Both are registered rather than listed in `app/`, because the endpoints
| they describe belong to features. `app/api/scopes.ts` owns what a scope
| *is* and how one is checked; `app/api/openapi.ts` owns the document's shape
| and the shared fragments; neither knows what this application actually
| serves.
|
| Scope order is the order they are offered on the key-creation form, listed
| in the spec, and stored on a key. It means nothing to enforcement, but a
| stable order is what makes two keys' stored JSON comparable.
|
| **Removing a feature means deleting its block here** — see
| `docs/modules.md`. The form, the spec, `/docs`, the key validator and the
| scope check all read the registry, so nothing else changes.
|
*/

import scopes from '#api/scopes'
import { openApi } from '#api/openapi'
import { accountLicensesOpenApi, licenseApiOpenApi } from '#licensing/openapi'
import { integrationOpenApi } from '#commerce/openapi'
import { licenseApiScopes } from '#licensing/api_scopes'

/**
 * A customer's own licenses (licence plan M5). Carries the type augmentation
 * that puts `licenses:read` into `ApiScope`.
 */
for (const [scope, definition] of licenseApiScopes) {
  scopes.register(scope, definition)
}

/**
 * Core scopes.
 *
 * Members exist whatever the product is, and an integration needs them to
 * resolve an assignee — so this one does not belong to a feature.
 */
scopes.register('members:read', {
  description: 'Read the member directory',
  default: true,
})

/**
 * The public license API (licence plan §6). No scopes — it is not called with
 * an API key — only its half of the published document.
 */
openApi.register(licenseApiOpenApi)
openApi.register(accountLicensesOpenApi)

/**
 * The integration API (licence plan §6, M4) — our own website's backend.
 */
openApi.register(integrationOpenApi)
