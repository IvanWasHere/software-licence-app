/*
|--------------------------------------------------------------------------
| Dashboard widgets
|--------------------------------------------------------------------------
|
| What the Overview screen shows, in the order it shows it (plan §13.5).
|
| The dashboard has no subject of its own — it is whatever the application's
| features have to say about a workspace — so it holds no queries and names
| nothing. Each widget here supplies a loader and a partial, and
| `pages/dashboard/index.edge` iterates them.
|
| The usage meters are not widgets: they come from the quota registry
| (`start/quotas.ts`) and are part of the shell of the page rather than
| something a feature contributes.
|
*/

import dashboard from '#dashboard/widgets'
import licensing from '#licensing/dashboard_service'

/**
 * Licenses (licence plan M5): the figures a customer checks first, and the
 * licenses they most recently got.
 */
dashboard.register({
  key: 'license_stats',
  region: 'stats',
  partial: 'pages/licenses/widgets/stats',
  load: (organization) => licensing.statsFor(organization),
})

dashboard.register({
  key: 'recent_licenses',
  region: 'panels',
  partial: 'pages/licenses/widgets/recent',
  load: (organization) => licensing.recent(organization),
})
