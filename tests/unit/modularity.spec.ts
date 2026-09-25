import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { test } from '@japa/runner'

/**
 * The architecture rule that makes a feature module removable (plan D8,
 * docs/modules.md).
 *
 * Core reaches a module **only through registration**: the quota, dashboard,
 * job, API-surface, route and seeder registries, plus the schema-rules path
 * in `config/database.ts`. Nothing else may import one.
 *
 * That property held when it was built and nothing kept it holding — the
 * first careless `import lists from '#modules/lists/services/list_service'`
 * in a core service would quietly restore the coupling that four rounds of
 * work removed, and no existing test would notice. This is the test that
 * notices.
 */

/**
 * Where a module may be reached from, and by what.
 *
 * Adding a file here is a deliberate act: it means core now depends on a
 * module somewhere new, and whoever removes that module has one more place
 * to edit. Prefer a registry.
 */
const REGISTRATION_POINTS = new Set([
  'start/quotas.ts',
  'start/dashboard.ts',
  'start/api.ts',
  'start/jobs.ts',
  'start/seeders.ts',
  'start/routes/web.ts',
  'start/routes/api.ts',

  /**
   * Not an import — lucid resolves this path itself, from
   * `schemaGeneration.rulesPaths`.
   */
  'config/database.ts',
])

/**
 * Directories that are core, and are therefore subject to the rule. `tests/`
 * is deliberately absent: the suites use the demo domain as their worked
 * example, which docs/modules.md explains and step 4 of that page is about.
 */
const CORE_ROOTS = ['app', 'start', 'config', 'commands', 'database']

/**
 * A real module specifier, not a mention of one in a comment. Both forms the
 * codebase uses: a static `from '#modules/…'` and a dynamic
 * `import('#modules/…')`.
 */
const MODULE_IMPORT = /(?:from\s*|import\s*\(\s*)['"]#modules\//

async function sourceFiles(root: string): Promise<string[]> {
  const found: string[] = []

  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)

      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.name.endsWith('.ts')) {
        found.push(path)
      }
    }
  }

  await walk(root)

  return found
}

test.group('Modularity', () => {
  test('only the registration points import a feature module', async ({ assert }) => {
    const offenders: string[] = []

    for (const root of CORE_ROOTS) {
      for (const path of await sourceFiles(root)) {
        /**
         * A module is allowed to import itself and its siblings.
         */
        if (path.startsWith(join('app', 'modules'))) {
          continue
        }

        if (REGISTRATION_POINTS.has(path)) {
          continue
        }

        if (MODULE_IMPORT.test(await readFile(path, 'utf8'))) {
          offenders.push(path)
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'these reach into a feature module without going through a registry — see docs/modules.md'
    )
  })
})
