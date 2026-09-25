/*
|--------------------------------------------------------------------------
| Demo seeders
|--------------------------------------------------------------------------
|
| What each feature puts into the demo workspaces `node ace dev:seed` builds
| (plan §12).
|
| The command owns the workspaces, the people, the subscriptions, the
| announcements and the operations rows. It does not know what your product's
| rows look like — so a feature registers a seeder, is handed the workspaces,
| and fills them itself.
|
| Seeders run in registration order, after every workspace and person exists.
|
| **Removing a feature means deleting its line here** — see
| `docs/modules.md`. Without it, `dev:seed` still builds a complete demo of
| everything core has.
|
*/

import seeders from '#seeding/demo_seeders'
import { licensingDemoSeeder } from '#seeding/licensing_seeder'

/**
 * The demo domain (D8) — delete with it.
 */
/**
 * The licensing demo — products, plans, licenses and activations for the
 * workspaces core builds (licence plan M5).
 */
seeders.register(licensingDemoSeeder)
