#!/usr/bin/env node
/**
 * A command-line app licensed with @licence-app/sdk.
 *
 *   node index.mjs activate WIPRO-XXXXX-XXXXX-XXXXX-XXXXX
 *   node index.mjs status
 *   node index.mjs deactivate
 *
 * Configure with environment variables (a real app compiles these in):
 *
 *   LICENSE_API         https://licenses.example.com/api/v1   (default: http://localhost:3333/api/v1)
 *   LICENSE_PRODUCT     the product slug                       (default: invoice-pro)
 *   LICENSE_PUBLIC_KEY  from GET /api/v1/keys → data[0].public_key
 *   LICENSE_KEY_ID      the matching kid                       (default: any)
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createLicenseClient, LicenseSdkError } from '@licence-app/sdk'
import { fileStorage } from '@licence-app/sdk/node'

const api = process.env.LICENSE_API ?? 'http://localhost:3333/api/v1'
const product = process.env.LICENSE_PRODUCT ?? 'invoice-pro'
const publicKey = process.env.LICENSE_PUBLIC_KEY

if (!publicKey) {
  console.error('Set LICENSE_PUBLIC_KEY (from GET /api/v1/keys). A real app ships with it pinned.')
  process.exit(2)
}

const license = createLicenseClient({
  baseUrl: api,
  product,
  publicKey: process.env.LICENSE_KEY_ID ? { [process.env.LICENSE_KEY_ID]: publicKey } : publicKey,
  storage: fileStorage(join(homedir(), `.${product}`, 'license.json')),
  clientVersion: '1.0.0',
  onChange: (state) =>
    console.log(state.valid ? '→ licensed' : `→ not licensed (${state.reason})`),
})

const [command, key] = process.argv.slice(2)

try {
  if (command === 'activate') {
    if (!key) throw new Error('Usage: node index.mjs activate <license-key>')
    const state = await license.activate(key, { label: `CLI on ${process.platform}` })
    print(state)
  } else if (command === 'deactivate') {
    const { deactivated } = await license.deactivate()
    console.log(deactivated ? 'Deactivated — the slot is free.' : 'Forgotten here; the server had no active slot for it.')
  } else {
    print(await license.validate())
  }
} catch (error) {
  if (error instanceof LicenseSdkError) {
    console.error(`${error.code}: ${error.message}`)
    process.exit(1)
  }
  throw error
}

/**
 * What the app does with the answer is its own decision — the SDK never
 * switches anything off. Here: premium commands only when `pdf_export` is on.
 */
function print(state) {
  if (!state.valid) {
    console.log(`Not licensed: ${state.reason}`)
    return
  }

  const expires = state.license?.expires_at ? `until ${state.license.expires_at.slice(0, 10)}` : 'for ever'
  console.log(`Licensed ${expires}${state.offline ? ' (offline — using the last good answer)' : ''}`)
  console.log(`Sites in use: ${state.license?.activations.used} of ${state.license?.activations.max ?? 'unlimited'}`)
  console.log(`PDF export: ${license.has('pdf_export') ? 'yes' : 'no'}`)
}
