import { test } from '@japa/runner'

import { compareVersions, parseVersion } from '#catalog/semver'
import { pickLatest, releaseAccess } from '#catalog/release_service'

/**
 * Which build every installation is offered, and whether it may have it
 * (licence plan M7). Pure, so pinned exhaustively here.
 */
test.group('Semver', () => {
  test('parses what release numbers look like, and nothing else', ({ assert }) => {
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
    assert.deepEqual(parseVersion('v2.0'), { major: 2, minor: 0, patch: 0, prerelease: [] })
    assert.deepEqual(parseVersion('2.0.0-beta.2+build.7')?.prerelease, ['beta', 2])

    for (const bad of ['', 'latest', '1.2.3.4', '1..2', '-1.0.0', '1.0.0-']) {
      assert.isNull(parseVersion(bad), bad)
    }
  })

  test('orders versions the way the spec does', ({ assert }) => {
    const ordered = [
      '0.9.9',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.2.0',
      '1.10.0',
      '2.0.0',
    ]

    for (let index = 1; index < ordered.length; index++) {
      assert.isBelow(
        compareVersions(ordered[index - 1], ordered[index]),
        0,
        `${ordered[index - 1]} < ${ordered[index]}`
      )
      assert.isAbove(compareVersions(ordered[index], ordered[index - 1]), 0)
    }

    assert.equal(compareVersions('1.0', '1.0.0'), 0)
    assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0, 'build metadata is ignored')
  })
})

test.group('Releases — which one is latest', () => {
  const release = (
    version: string,
    channel: 'stable' | 'beta' = 'stable',
    status = 'published'
  ) => ({
    version,
    channel,
    status,
  })

  test('the highest version, not the newest upload', ({ assert }) => {
    const releases = [release('1.10.0'), release('1.9.0'), release('1.2.0')]
    assert.equal(pickLatest(releases, 'stable')?.version, '1.10.0')
  })

  test('stable never sees a beta; beta sees both', ({ assert }) => {
    const releases = [release('1.0.0'), release('2.0.0-beta.1', 'beta')]

    assert.equal(pickLatest(releases, 'stable')?.version, '1.0.0')
    assert.equal(pickLatest(releases, 'beta')?.version, '2.0.0-beta.1')

    releases.push(release('2.0.0'))
    assert.equal(pickLatest(releases, 'beta')?.version, '2.0.0', 'a tester moves on to the release')
  })

  test('drafts and withdrawn builds are never offered', ({ assert }) => {
    const releases = [
      release('1.0.0'),
      release('1.1.0', 'stable', 'yanked'),
      release('1.2.0', 'stable', 'draft'),
    ]

    assert.equal(pickLatest(releases, 'stable')?.version, '1.0.0')
    assert.isNull(pickLatest([release('1.0.0', 'stable', 'yanked')], 'stable'))
  })
})

test.group('Releases — who may download', () => {
  const PUBLISHED = Date.parse('2026-06-01T00:00:00Z')
  const VALID = { valid: true as const, reason: null }

  test('a free build goes to anybody, key or not', ({ assert }) => {
    assert.isTrue(
      releaseAccess({
        release: { licenseRequired: false, publishedAtMs: PUBLISHED },
        licenseCheck: null,
        updatesUntilMs: null,
      }).allowed
    )
  })

  test('a licensed build needs a key', ({ assert }) => {
    assert.deepEqual(
      releaseAccess({
        release: { licenseRequired: true, publishedAtMs: PUBLISHED },
        licenseCheck: null,
        updatesUntilMs: null,
      }),
      { allowed: false, reason: 'license_required' }
    )
  })

  test('an invalid license is refused with its own reason', ({ assert }) => {
    for (const reason of ['license_expired', 'license_revoked', 'not_activated'] as const) {
      assert.deepEqual(
        releaseAccess({
          release: { licenseRequired: true, publishedAtMs: PUBLISHED },
          licenseCheck: { valid: false, reason },
          updatesUntilMs: null,
        }),
        { allowed: false, reason }
      )
    }
  })

  test('an update window covers what was published inside it, and not after', ({ assert }) => {
    const access = (updatesUntilMs: number | null) =>
      releaseAccess({
        release: { licenseRequired: true, publishedAtMs: PUBLISHED },
        licenseCheck: VALID,
        updatesUntilMs,
      })

    assert.isTrue(access(null).allowed, 'no window: updates forever')
    assert.isTrue(access(PUBLISHED).allowed, 'published on the last day')
    assert.isTrue(access(PUBLISHED + 1).allowed)
    assert.deepEqual(access(PUBLISHED - 1), { allowed: false, reason: 'updates_expired' })
  })
})
