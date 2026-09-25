import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLicenseClient, memoryStorage, LicenseSdkError } from '../dist/esm/index.js'
import { fileStorage } from '../dist/esm/node.js'

/**
 * The SDK against a fake license server that signs its answers with a real
 * Ed25519 key, exactly as the real one does — so every trust decision the SDK
 * makes is exercised, not assumed.
 */

const HOUR = 3_600_000
const KEY = 'WIPRO-7K4DX-82M91-QP6F3-A0ZT9'

function server(options = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyB64 = publicKey.export({ format: 'jwk' }).x
  const state = {
    now: Date.parse('2026-09-26T10:00:00Z'),
    down: false,
    calls: [],
    activated: new Set(),
    maxActivations: options.maxActivations ?? 3,
    valid: true,
    reason: null,
    tamper: null,
  }

  const answer = (payload) => {
    const bytes = Buffer.from(JSON.stringify(payload))
    let signature = sign(null, bytes, privateKey).toString('base64url')
    let body = bytes.toString('base64url')

    if (state.tamper === 'signature') signature = Buffer.alloc(64).toString('base64url')
    if (state.tamper === 'payload') {
      body = Buffer.from(JSON.stringify({ ...payload, valid: true, reason: null })).toString(
        'base64url'
      )
    }

    return { ...payload, signed: { alg: 'Ed25519', kid: 'k1', payload: body, signature } }
  }

  const fetch = async (url, init) => {
    if (state.down) throw new TypeError('fetch failed')

    const action = url.split('/').pop()
    const body = JSON.parse(init.body)
    state.calls.push({ action, body })

    if (!body.product || !body.license_key) {
      return new Response(JSON.stringify({ error: { code: 'validation_failed' } }), { status: 422 })
    }

    const known = body.license_key === KEY
    const envelope = {
      product: state.tamper === 'product' ? 'another-product' : body.product,
      instance_id: body.instance_id ?? null,
      nonce: state.tamper === 'nonce' ? 'replayed-nonce' : body.nonce,
      checked_at: new Date(state.now).toISOString(),
      request_id: 'req_1',
    }
    const policy = { validation_interval_hours: 24, offline_grace_days: 7 }
    const entitlements = { pdf_export: true, max_clients: 500, white_label: false }

    if (action === 'activate') {
      if (!known) {
        return Response.json(answer({ activated: false, valid: false, reason: 'invalid_license', entitlements: {}, policy, ...envelope }))
      }
      if (!state.activated.has(body.instance_id) && state.activated.size >= state.maxActivations) {
        return Response.json(answer({ activated: false, valid: false, reason: 'activation_limit_reached', entitlements: {}, policy, ...envelope }))
      }
      state.activated.add(body.instance_id)
      return Response.json(answer({ activated: true, valid: true, reason: null, entitlements, policy, ...envelope }))
    }

    if (action === 'validate') {
      const valid = known && state.valid && state.activated.has(body.instance_id)
      const reason = !known ? 'invalid_license' : !state.valid ? state.reason : valid ? null : 'not_activated'
      return Response.json(answer({ valid, reason, entitlements: valid ? entitlements : {}, policy, ...envelope }))
    }

    if (action === 'deactivate') {
      const deactivated = state.activated.delete(body.instance_id)
      return Response.json(answer({ deactivated, reason: null, ...envelope }))
    }

    return new Response('not found', { status: 404 })
  }

  return { state, fetch, publicKey: publicKeyB64 }
}

function client(fake, extra = {}) {
  return createLicenseClient({
    baseUrl: 'https://licenses.test/api/v1',
    product: 'invoice-pro',
    publicKey: fake.publicKey,
    storage: extra.storage ?? memoryStorage(),
    fetch: fake.fetch,
    now: () => fake.state.now,
    ...extra,
  })
}

test('with no key yet, it says so without asking anybody', async () => {
  const fake = server()
  const sdk = client(fake)

  const state = await sdk.validate()

  assert.equal(state.valid, false)
  assert.equal(state.reason, 'no_license_key')
  assert.equal(fake.state.calls.length, 0)
})

test('activates, remembers the key, and reads entitlements', async () => {
  const fake = server()
  const sdk = client(fake, { clientVersion: '2.4.1' })

  const state = await sdk.activate(`  ${KEY}  `, { siteUrl: 'https://shop.example.com' })

  assert.equal(state.valid, true)
  assert.equal(state.source, 'network')
  assert.equal(fake.state.calls[0].body.license_key, KEY, 'trimmed')
  assert.equal(fake.state.calls[0].body.client_version, '2.4.1')
  assert.equal(fake.state.calls[0].body.site_url, 'https://shop.example.com')

  assert.equal(sdk.has('pdf_export'), true)
  assert.equal(sdk.has('white_label'), false)
  assert.equal(sdk.get('max_clients', 0), 500)
  assert.equal(sdk.get('missing', 'fallback'), 'fallback')
})

test('a refused activation is a state, and the key is not remembered', async () => {
  const fake = server({ maxActivations: 0 })
  const sdk = client(fake)

  const state = await sdk.activate(KEY)

  assert.equal(state.valid, false)
  assert.equal(state.reason, 'activation_limit_reached')
  assert.equal((await sdk.validate()).reason, 'no_license_key')
})

test('a fresh answer is reused; a stale one is asked again', async () => {
  const fake = server()
  const sdk = client(fake)
  await sdk.activate(KEY)

  fake.state.now += 23 * HOUR
  const cached = await sdk.validate()
  assert.equal(cached.source, 'cache')
  assert.equal(fake.state.calls.length, 1, 'no call inside the interval')

  fake.state.now += 2 * HOUR
  const fresh = await sdk.validate()
  assert.equal(fresh.source, 'network')
  assert.equal(fake.state.calls.length, 2)
})

test('force skips the cache', async () => {
  const fake = server()
  const sdk = client(fake)
  await sdk.activate(KEY)

  const state = await sdk.validate({ force: true })

  assert.equal(state.source, 'network')
})

test('a "no" is reused for an hour, then asked again', async () => {
  const fake = server()
  const sdk = client(fake)
  await sdk.activate(KEY)

  fake.state.valid = false
  fake.state.reason = 'license_suspended'
  assert.equal((await sdk.validate({ force: true })).reason, 'license_suspended')

  fake.state.valid = true
  fake.state.now += 30 * 60_000
  assert.equal((await sdk.validate()).reason, 'license_suspended', 'still the cached no')

  fake.state.now += 31 * 60_000
  assert.equal((await sdk.validate()).valid, true, 'asked again, and fixed')
})

test('offline, the last good answer stands for the grace period, then it does not', async () => {
  const fake = server()
  const sdk = client(fake)
  await sdk.activate(KEY)

  fake.state.down = true
  fake.state.now += 3 * 24 * HOUR

  const inside = await sdk.validate()
  assert.equal(inside.valid, true)
  assert.equal(inside.offline, true)
  assert.equal(inside.source, 'offline')
  assert.equal(sdk.has('pdf_export'), true, 'entitlements survive offline')

  fake.state.now += 5 * 24 * HOUR

  const outside = await sdk.validate()
  assert.equal(outside.valid, false)
  assert.equal(outside.reason, 'offline_grace_expired')
})

test('a 5xx is offline, not a verdict', async () => {
  const fake = server()
  const sdk = client(fake)
  await sdk.activate(KEY)

  const realFetch = fake.fetch
  const flaky = client(fake, {
    storage: undefined,
    fetch: async (url, init) =>
      url.endsWith('/validate') ? new Response('boom', { status: 503 }) : realFetch(url, init),
  })
  await flaky.activate(KEY)
  fake.state.now += 25 * HOUR

  const state = await flaky.validate()
  assert.equal(state.valid, true)
  assert.equal(state.offline, true)
})

for (const [kind, label] of [
  ['signature', 'a forged signature'],
  ['payload', 'an edited payload'],
  ['nonce', 'a replayed answer (wrong nonce)'],
  ['product', 'an answer for another product'],
]) {
  test(`${label} is not believed`, async () => {
    const fake = server()
    const sdk = client(fake)
    await sdk.activate(KEY)

    fake.state.valid = false
    fake.state.reason = 'license_revoked'
    fake.state.tamper = kind
    fake.state.now += 25 * HOUR

    const state = await sdk.validate()

    /**
     * Not the forged "valid", and not the real "revoked" either — the answer
     * is treated as no answer, so the last good one stands inside the grace.
     */
    assert.equal(state.source, 'offline')
    assert.equal(state.offline, true)
  })
}

test('with nothing good to fall back on, an untrusted answer says so', async () => {
  const fake = server()
  const storage = memoryStorage()
  const sdk = client(fake, { storage })
  await sdk.activate(KEY)

  const record = JSON.parse(storage.get('licence-app:invoice-pro'))
  storage.set('licence-app:invoice-pro', JSON.stringify({ ...record, answer: null, lastGood: null }))

  fake.state.tamper = 'signature'
  const state = await sdk.validate()

  assert.equal(state.valid, false)
  assert.equal(state.reason, 'untrusted_response')
})

test('an edited cache is not believed', async () => {
  const fake = server()
  const storage = memoryStorage()
  const sdk = client(fake, { storage })
  await sdk.activate(KEY)

  const record = JSON.parse(storage.get('licence-app:invoice-pro'))
  const forged = Buffer.from(
    JSON.stringify({ valid: true, reason: null, product: 'invoice-pro', checked_at: '2099-01-01T00:00:00Z' })
  ).toString('base64url')
  storage.set(
    'licence-app:invoice-pro',
    JSON.stringify({ ...record, answer: { ...record.answer, payload: forged } })
  )

  await sdk.validate()

  assert.equal(fake.state.calls.length, 2, 'the forged cache was ignored and the server asked')
})

test('keeps one installation id across restarts', async () => {
  const fake = server()
  const storage = memoryStorage()

  const first = client(fake, { storage })
  const id = await first.instanceId()
  await first.activate(KEY)

  const second = client(fake, { storage })
  assert.equal(await second.instanceId(), id)
  assert.equal((await second.validate()).valid, true, 'and the key came with it')
})

test('deactivating frees the slot and forgets the key', async () => {
  const fake = server()
  const sdk = client(fake)
  await sdk.activate(KEY)

  assert.deepEqual(await sdk.deactivate(), { deactivated: true })
  assert.equal(fake.state.activated.size, 0)
  assert.equal((await sdk.validate()).reason, 'no_license_key')
})

test('reports changes, and only changes', async () => {
  const fake = server()
  const seen = []
  const sdk = client(fake, { onChange: (state) => seen.push(state.reason ?? 'valid') })

  await sdk.activate(KEY)
  await sdk.validate({ force: true })

  fake.state.valid = false
  fake.state.reason = 'license_expired'
  await sdk.validate({ force: true })

  assert.deepEqual(seen, ['valid', 'license_expired'])
})

test('a malformed request is a thrown error, not a state', async () => {
  const fake = server()
  const sdk = client(fake)

  await assert.rejects(() => sdk.activate(''), LicenseSdkError)
})

test('activation needs the server; it throws when there is none', async () => {
  const fake = server()
  fake.state.down = true

  await assert.rejects(() => client(fake).activate(KEY), (error) => error.code === 'network')
})

test('file storage keeps the record on disk, private to the user', async () => {
  const fake = server()
  const path = join(await mkdtemp(join(tmpdir(), 'licence-sdk-')), 'nested', 'license.json')

  await client(fake, { storage: fileStorage(path) }).activate(KEY)

  const onDisk = JSON.parse(await readFile(path, 'utf8'))
  assert.ok(onDisk['licence-app:invoice-pro'])

  const restarted = client(fake, { storage: fileStorage(path) })
  assert.equal((await restarted.validate()).valid, true)
})
