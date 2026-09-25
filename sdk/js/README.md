# 🔑 @licence-app/sdk

Validate, activate and deactivate licenses against a [Licence App](../../README.md) server, from
browsers, Node, Electron, Deno or Bun.

- 🪶 **Zero dependencies**, about 3 KB gzipped. It uses `fetch` and WebCrypto, which are already in
  your runtime.
- 🔏 **Believes only signed answers.** Every answer must verify against a key you pin, and must echo
  this request's nonce, product and installation. The cache is re-verified every time it is read.
- 📴 **Keeps working offline.** When the server can't be reached, the last good answer stands for
  the product's offline grace period.
- 🧘 **Never switches anything off by itself.** It reports a state; your software decides what to
  lock.

```bash
npm install @licence-app/sdk
```

## 🚀 Quick start

```js
import { createLicenseClient } from '@licence-app/sdk'

const license = createLicenseClient({
  baseUrl: 'https://licenses.example.com/api/v1',
  product: 'invoice-pro',
  // From GET /api/v1/keys → data[0]. Pin it in your build; never fetch it at runtime.
  publicKey: { k1: 'p8Yx…32-byte-key-base64url' },
})

// Once, when the customer enters their key
const activated = await license.activate('WIPRO-7K4DX-82M91-QP6F3-A0ZT9', {
  siteUrl: 'https://shop.example.com',
})

// Whenever you want to know — cheap, answered from the cache most of the time
const state = await license.validate()

if (state.valid) {
  enablePremium()
}

if (license.has('pdf_export')) showPdfButton()
const maxClients = license.get('max_clients', 50)
```

## 🧠 How it decides

| Situation | What `validate()` returns |
|---|---|
| A verified answer younger than the product's `validation_interval_hours` | That answer, `source: 'cache'`; no request |
| Older, or `validate({ force: true })` | A fresh answer from the server, `source: 'network'` |
| Server unreachable, a 5xx, a 429, or an answer that doesn't verify | The last **valid** answer, `offline: true`, while it is younger than `offline_grace_days`. After that, `valid: false, reason: 'offline_grace_expired'` |
| A "no" from the server | Reused for an hour (`invalidCacheMinutes`), so a customer who fixes their billing is unblocked quickly |
| No key entered yet | `valid: false, reason: 'no_license_key'` without asking anybody |

Every age is measured from the **signed** `checked_at`, so an edited cache can't make an old answer
look fresh. The limit is the machine's own clock: somebody who turns their clock back can stretch a
cached answer, but can't forge one.

### Reasons

From the server, and permanent: `invalid_license`, `product_mismatch`, `license_revoked`,
`license_suspended`, `license_expired`, `subscription_inactive`, `not_activated`,
`activation_limit_reached`.

From the SDK: `no_license_key`, `offline_grace_expired`, and `untrusted_response` (an answer
arrived but didn't verify, and there was no good answer to fall back on).

### Errors

Business answers never throw; a refused activation is a state with a reason. Three things do throw,
as `LicenseSdkError`:

| `code` | When |
|---|---|
| `network` | `activate()` couldn't reach the server. Activation can't be done offline. |
| `untrusted_response` | `activate()` got an answer that doesn't verify. Check the pinned key. |
| `rejected_request` | The server answered 422: the request was malformed, e.g. an empty key. |

## ⚙️ Options

| Option | Default | |
|---|---|---|
| `baseUrl` | — | The license API, ending in `/api/v1` |
| `product` | — | The product slug |
| `publicKey` | — | `{ kid: key }`, or a single key for any `kid`. Keep two across a rotation |
| `storage` | `localStorage` in browsers, memory elsewhere | `{ get, set, remove }`, sync or async |
| `instanceId` | generated once, stored | Pass your own if you already have an installation id |
| `clientVersion` | — | Sent on activation, and shown in the customer's account |
| `onChange(state)` | — | Called when validity or the reason changes |
| `invalidCacheMinutes` | `60` | How long a "no" is reused |
| `fetch`, `now`, `verify` | built-ins | Injectable, for tests and for runtimes without WebCrypto Ed25519 |

### 💾 Storage in Node

```js
import { fileStorage } from '@licence-app/sdk/node'

createLicenseClient({ /* … */, storage: fileStorage(`${os.homedir()}/.invoice-pro/license.json`) })
```

The file is written with mode `0600`. The `/node` entry is separate, so a browser bundle never pulls
in `node:fs`.

## 🔒 A word on the browser

Anything that runs in a browser can be patched out by whoever controls that browser. For a web app,
the real gate belongs on **your server**: run this SDK there, with `fileStorage` or your own
storage, and send the page only what the license allows. The SDK holds no secrets, so shipping it
to a page is safe. It just can't stop somebody who edits their own copy of your JavaScript.

## 🧪 Development

```bash
npm install
npm test            # builds, then runs the suite against a signing fake server
npm run typecheck
npm run size        # fails above 4 KB gzipped
```

The server's own suite runs this SDK against the real API (`tests/functional/sdk`), so the two
can't drift apart.
