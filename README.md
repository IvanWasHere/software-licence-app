<div align="center">

<img src="docs/logo.svg" alt="" width="88" height="88" />

# 🔑 Licence App

**A self-hosted license and commerce server for a company that sells its own software:
WordPress plugins, desktop and web apps, JS libraries.**

Customers buy a plan, get a license key, and the software asks this server whether that key is good.

🐿️ SQLite locally with zero setup · 🐘 PostgreSQL when deployed · 🅰️ AdonisJS 7

[What it does](#-what-it-does) · [Quick start](#-quick-start) · [Examples](#-examples) ·
[How it works](#-how-it-works) · [Environment](#-environment) · [Commands](#%EF%B8%8F-commands) ·
[Roadmap](#%EF%B8%8F-roadmap)

</div>

---

## 🤔 What it does

It is **not a SaaS**. One company deploys it for its own products. Products, plans and prices are
rows in the database, so adding a tenth product needs no code change.

- 📦 **Catalog.** Products with plans (monthly, yearly, lifetime, fixed-length trials) and
  **entitlements**: feature flags and limits such as `pdf_export` or `max_clients` that your
  software reads at runtime.
- 🔑 **License keys** like `WIPRO-7K4DX-82M91-QP6F3-A0ZT9`.
  - Looked up by a hash of the key and also stored encrypted, so support can read one back.
  - Forgiving to type: case, dashes and `O`/`0` mix-ups don't matter.
- 🌐 **A public license API.** Validate, activate and deactivate installations.
  - Answers are **signed with Ed25519**, so a cached answer or a fake local server can't unlock anything.
  - An invalid license is a normal `200` answer with a permanent reason code, never an error.
- 🖥️ **Activations with limits.** "3 sites" means 3.
  - Development and staging sites (`localhost`, `*.test`, `staging.*`, …) are free.
  - Activating the same installation twice counts once.
- 💳 **Payments through [Creem](https://creem.io).**
  - One-time purchases issue perpetual licenses; subscriptions keep a license alive period by period.
  - Refunds revoke, disputes suspend, and a failed renewal gets a grace period before the license lapses.
- 🛒 **A pricing page and checkout**, or an **integration API** if your marketing site lives somewhere else.
- 👤 **A customer portal.** Keys, where each one is installed, a button to free a slot, orders and invoices.
- 🧑‍💼 **A back-office.**
  - Products, plans, licenses, orders, webhooks, the job queue and the audit log.
  - Support can read keys back and free slots. Only admins can grant or revoke.

Built on the [kitch4nSinkV2](https://github.com/IvanWasHere/kitch4nSinkV2) starter, so the
unglamorous parts come with it: staff 2FA, impersonation, an idempotent webhook ledger, a
database-backed queue, rate limits, an audit trail, and tests that run against both SQLite and
PostgreSQL.

📓 [`plan.md`](./plan.md) is the design document and the source of truth for scope and decisions.
🛠️ [`CONTRIBUTING.md`](./CONTRIBUTING.md) has the rules that keep it working. Read it before
changing anything.

---

## 🚀 Quick start

You need **Node 24+**. Nothing else is required, because SQLite needs no server.

```bash
# 1️⃣  Install
npm install

# 2️⃣  Configure
cp .env.example .env
node ace generate:key          # writes APP_KEY

# 3️⃣  Database, test accounts and a demo catalog
node ace migration:fresh --seed
node ace dev:seed              # 🏭 "Invoice Pro" with plans, licenses, installs and payments

# 4️⃣  Run it
npm run dev                    # 🌐 http://localhost:3333
node ace queue:work            # ⚙️  second terminal: webhooks and email need it
```

Then look around:

| Where | What |
|---|---|
| 🛒 `/pricing/invoice-pro` | The public pricing page with Buy buttons |
| 🔑 `/licenses` | The customer portal (sign in as a customer below) |
| 🧑‍💼 `/admin/products`, `/admin/licenses`, `/admin/orders` | The back-office |
| 📖 `/docs` | The API reference, generated from `/openapi.json` |

### 🔐 Accounts

| Account | Password | Signs in at | What you'll see |
|---|---|---|---|
| 🛡️ `admin@example.com` | `Admin12345` | `/admin/login` | Staff: **admin** |
| 🎧 `support@example.com` | `Support12345` | `/admin/login` | Staff: **support** |
| 🏢 `owner-pro@example.com` | `correct-horse-battery` | `/login` | An agency with licenses on several sites *(after `dev:seed`)* |
| 👑 `user-manager@example.com` | `Manager12345` | `/login` | An account owner |

> 🔢 Staff two-factor is mandatory. In development enter **`123456`** (see `DEV_TWO_FACTOR_CODE`),
> or run `node ace dev:totp admin@example.com` for a real code.

Emails (license keys, receipts, renewal failures) are sent through the queue to
[Mailpit](https://mailpit.axllent.org) locally: `brew install mailpit && mailpit`, then open
<http://localhost:8025>.

---

## 🧪 Examples

All examples assume `BASE=http://localhost:3333/api/v1` and a key issued in the back-office
(`/admin/licenses/new`) or bought through `/pricing/invoice-pro`.

### ✅ Is this key good?

```bash
curl -s $BASE/licenses/validate -H 'content-type: application/json' \
  -d '{"product":"invoice-pro","license_key":"WIPRO-7K4DX-82M91-QP6F3-A0ZT9"}'
```

```jsonc
{
  "valid": true,
  "reason": null,
  "license": {
    "id": "lic_7fj2k9pqrstu",
    "status": "active",
    "type": "perpetual",
    "expires_at": null,
    "product": "invoice-pro",
    "plan": "lifetime",
    "key_suffix": "0ZT9",
    "activations": { "used": 2, "max": 3 }
  },
  "entitlements": { "pdf_export": true, "recurring_invoices": true, "max_clients": 100000 },
  "policy": { "validation_interval_hours": 24, "offline_grace_days": 7 },
  "product": "invoice-pro",
  "instance_id": null,
  "nonce": null,
  "checked_at": "2026-09-26T10:00:00.000Z",
  "request_id": "7c9e…",
  "signed": { "alg": "Ed25519", "kid": "k1", "payload": "eyJ2YWxpZCI6dHJ1…", "signature": "…" }
}
```

A bad key is still a `200`. Branch on `reason`, never on the HTTP status:

```jsonc
{ "valid": false, "reason": "license_expired", "entitlements": {}, … }
```

| `reason` | Meaning |
|---|---|
| `invalid_license` | No such key |
| `product_mismatch` | A real key, for another product |
| `license_revoked` / `license_suspended` | Staff or a refund / dispute took it out of service |
| `license_expired` | Past its expiry date |
| `subscription_inactive` | The subscription behind it has ended |
| `not_activated` | This installation isn't activated |
| `activation_limit_reached` | Every slot is taken |

### 🖥️ Activate this installation

The client generates an `instance_id` once (a UUID is ideal) and keeps it.

```bash
curl -s $BASE/licenses/activate -H 'content-type: application/json' -d '{
  "product": "invoice-pro",
  "license_key": "WIPRO-7K4DX-82M91-QP6F3-A0ZT9",
  "instance_id": "4f7c2b1e-9d1a-4c3e-8f0b-2a6d5e9c1b77",
  "site_url": "https://shop.example.com",
  "client_version": "2.4.1"
}'
```

```jsonc
{
  "activated": true,
  "valid": true,
  "activation": { "id": "act_…", "instance_id": "4f7c…", "hostname": "shop.example.com", "is_dev": false },
  "license": { "activations": { "used": 3, "max": 3 }, … },
  …
}
```

At the limit you get `activated: false` and `reason: "activation_limit_reached"`, with the numbers.
`POST /licenses/deactivate` with the same three fields frees the slot.

### 🔏 Trust only what is signed

Everything a client should rely on is inside `signed.payload`: base64url of the exact JSON bytes
that were signed. Verify, then parse. There's no re-serialising of JSON, so PHP and JS agree
byte for byte.

```js
// Node 20+ or any modern browser — WebCrypto has Ed25519 built in
const { data: [key] } = await (await fetch(`${BASE}/keys`)).json() // pin this in your app

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function verified(answer) {
  const publicKey = await crypto.subtle.importKey('raw', b64url(key.public_key), 'Ed25519', false, ['verify'])
  const bytes = b64url(answer.signed.payload)
  const ok = await crypto.subtle.verify('Ed25519', publicKey, b64url(answer.signed.signature), bytes)

  return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null
}
```

Send a random `nonce` with each request and check it comes back inside the payload, so an old
signed answer can't be replayed. The same goes for `product` and `instance_id`.

### 🛒 Sell from your own website (integration API)

Mint a key for your website's backend. It belongs to a special system account, and no customer
key can reach these endpoints:

```bash
node ace licensing:integration-key --name="Website backend"
# ✔ Integration key created … It is shown once:
# sk_live_…
```

```bash
# 1. Start a checkout and send the buyer to the URL you get back
curl -s $BASE/checkout -H "authorization: Bearer $SK" -H 'content-type: application/json' -d '{
  "product": "invoice-pro", "plan": "yearly",
  "email": "buyer@example.com",
  "success_url": "https://your-site.example/thanks"
}'
# → { "data": { "order_id": "ord_…", "status": "pending", "checkout_url": "https://checkout.creem.io/…" } }

# 2. On your thank-you page, poll until the payment webhook has landed
curl -s $BASE/orders/ord_… -H "authorization: Bearer $SK"
# → { "data": { "status": "paid", "licenses": [{ "id": "lic_…", "key_suffix": "0ZT9", … }] } }

# 3. "Resend my key" form
curl -s "$BASE/customers/licenses?email=buyer@example.com" -H "authorization: Bearer $SK"
```

The key itself never travels through this API. It goes to the buyer by email and sits in their
account.

### 👤 A customer's own tooling

Account owners can mint API keys under **API Keys** in the sidebar, with the `licenses:read` scope:

```bash
curl -s $BASE/licenses -H "authorization: Bearer sk_live_…"
# → { "data": [ { "id": "lic_…", "product": "invoice-pro", "status": "active", … } ], "meta": { "next_cursor": null } }
```

📖 More in [`docs/license-api.md`](./docs/license-api.md), and everything else at `/docs`.

---

## 🧭 How it works

```
            🛒 /pricing  or  your website ── POST /api/v1/checkout ──┐
                                                                     ▼
   buyer ──────────────► Creem checkout ─── webhook ───► 🪝 /webhooks/creem
                                                             │  verify · record · queue
                                                             ▼
                                                   ⚙️ worker: fulfil the order
                                             account ← email we recorded · license issued
                                                   · key emailed · payment recorded
                                                             │
   🔌 plugin / app ── POST /api/v1/licenses/validate ──► 🔑 license + activations
                    ◄── signed answer, cached for `validation_interval_hours`
```

Some decisions worth knowing, all explained in [`plan.md`](./plan.md):

- 🪝 **Webhooks are the only source of truth.** The return page after checkout grants nothing.
  Creem sends several events per checkout; an order row lock plus a unique license per order item
  means exactly one license gets issued.
- 🔗 **A payment is matched to *our* order id**, which we put into the checkout ourselves. It is
  never matched by an email from the webhook, because the payer controls that.
- ⏳ **Dunning without a job.** A subscription license expires at *end of paid period + 7 days*.
  Each renewal moves it; failed renewals just let it lapse.
- 🧊 **Validity is computed on every call, never stored.** Nothing has to flip a row at midnight.
- 🧱 **What shipped is permanent.** Product slugs, a plan's billing and term, and entitlement keys
  can only change while a product is a draft. Prices can change any time; licenses copy what they
  need when they're issued.
- 🚦 **Two API surfaces that never mix.** The keyless license API has open CORS and per-key rate
  limits. The organisation API uses bearer keys scoped to one account.

---

## 🔧 Environment

Copy `.env.example` to `.env`. **`APP_KEY` is the only value you have to generate.** Everything
else is either pre-filled or belongs to a feature you can leave off.

### ✅ Required

| Variable | Notes |
|---|---|
| `APP_KEY` | 🔑 `node ace generate:key`. Signs cookies and encrypts 2FA secrets **and license keys**, so rotating it makes stored keys unreadable |
| `APP_URL` | 🌐 Used in emails and checkout return URLs, so it must be the real hostname in production |

### 🔏 Licensing

| Variable | Notes |
|---|---|
| `LICENSE_SIGNING_KEY` | Ed25519 private key that signs license answers. **Required in production.** `node ace licensing:keygen` prints a pair. Unset locally, a throwaway key is used per process |
| `LICENSE_SIGNING_KEY_ID` | Published beside each signature (`kid`), so clients can hold two keys across a rotation |

Tunables such as the renewal grace, dev-site patterns and heartbeat throttle live in
[`config/licensing.ts`](./config/licensing.ts).

### 💳 Payments ([Creem](https://creem.io))

| Variable | Notes |
|---|---|
| `CREEM_API_KEY` | 🔐 Your secret key |
| `CREEM_API_URL` | `https://test-api.creem.io`. Switching to the **live** host is a deliberate, visible change |
| `CREEM_WEBHOOK_SECRET` | 🪝 HMAC secret for `POST /webhooks/creem` |

Each plan is mapped to a Creem product in the back-office (**Products → plan → Payment-provider
product id**). A plan without one can't be sold online, but can still be issued by hand.

> 🚇 For local webhooks: `cloudflared tunnel --url http://localhost:3333`, then
> `node ace billing:replay <id>` to re-run a stored payload with **no network at all**.

### 🗄️ Database · 📧 Mail · 📁 Storage · 🧰 Operations

| Variable | Default | Notes |
|---|---|---|
| `DB_CONNECTION` | `sqlite` | `sqlite` \| `postgres` |
| `DB_SQLITE_PATH` | `./tmp/db.sqlite3` | SQLite only |
| `DATABASE_URL` | — | 🐘 Postgres (or the discrete `DB_*` vars) |
| `MAIL_MAILER` | `smtp` | `smtp` (Mailpit) locally, `resend` in production |
| `MAIL_FROM_ADDRESS` / `MAIL_FROM_NAME` | | ⚠️ Resend only sends from a DNS-verified domain |
| `RESEND_API_KEY` | — | When `MAIL_MAILER=resend` |
| `DRIVE_DISK` | `fs` | `fs` locally \| `r2` in production (uploads now, release downloads from M7) |
| `R2_*` | — | Cloudflare R2 credentials and bucket |
| `ADMIN_IP_ALLOWLIST` | — | 🚧 Gates all of `/admin`. A second layer, **never** the boundary |
| `TRUST_PROXY` | `false` | ⚠️ Decides what every rate limit counts against. Turn it on only behind a proxy you control |
| `DEV_TWO_FACTOR_CODE` | `123456` | ⚠️ Development only. Unset it anywhere that isn't a laptop |

The full list, with notes, is in [`.env.example`](./.env.example) and
[`docs/deployment.md`](./docs/deployment.md).

---

## ⌨️ Commands

```bash
npm run dev            # 🔥 dev server with HMR
npm test               # 🧪 unit, functional and browser suites
npm run lint           # 🧹 eslint
npm run typecheck      # 🟦 tsc --noEmit
npm run build          # 📦 compile for production
```

### 🔑 Licensing & commerce

```bash
node ace licensing:keygen                        # 🔏 a new response-signing key pair
node ace licensing:integration-key --name=Site   # 🛒 a key for your website's backend
node ace billing:sync --dry-run                  # 🔍 diff local subscriptions against Creem
node ace billing:replay --failed                 # 🪝 re-apply stored webhooks, no network
```

### 🗄️ Database, queue & staff

```bash
node ace migration:run                  # apply migrations (regenerates database/schema.ts)
node ace migration:fresh --seed         # start over with the test accounts
node ace dev:seed                       # 🏭 the demo catalog, customers and licenses
node ace queue:work                     # ⚙️ the worker: webhooks, email and jobs need it
node ace schedule:run --interval=daily  # 🕐 cron calls this; it only dispatches
node ace staff:create --role=admin      # 🛡️ a back-office account
```

---

## 🗂️ How it is organised

```
app/
  catalog/        📦 products, plans, entitlements (pure rules + CatalogService)
  licensing/      🔑 keys, validation, activations, signer, license API payloads
  commerce/       🛒 orders, customer accounts, refund/dispute effects, integration keys
  billing/        💳 PaymentProvider (Creem), webhook handler, reconciliation
  controllers/    admin/ · api/v1/ · licenses/ · storefront/ · billing/ …
  api/ audit/ auth/ queue/ storage/ notifications/ support/   (from the starter)
config/           licensing.ts · plans.ts (account limits) · payments.ts · …
database/         migrations · seeders · generated schema types
start/routes/     web · auth · api · license_api · billing · admin
tests/            unit · functional (licensing, license_api, commerce, portal, tenant isolation…) · browser
docs/             license-api.md · deployment.md · security.md · …
```

**Stack:** TypeScript · AdonisJS 7 · Lucid · VineJS · Edge + Alpine.js · Japa · SQLite / PostgreSQL ·
Creem · Resend · Cloudflare R2.

---

## 🗺️ Roadmap

| | Milestone | |
|---|---|---|
| ✅ | **M0** Fork the starter | |
| ✅ | **M1** Catalog: products, plans, entitlements | `/admin/products` |
| ✅ | **M2** Licensing core: keys, validation, activations, signing | `/admin/licenses` |
| ✅ | **M3** Public license API | `/api/v1/licenses/*` |
| ✅ | **M4** Payments → licenses: orders, Creem webhooks, integration API | `/admin/orders` |
| 🚧 | **M5** Customer portal and pricing page; stripping the starter's SaaS demo | in progress |
| ⏳ | **M6** JS SDK: tiny, zero-dependency, cached, signature-verifying | `sdk/js` |
| ⏳ | **M7** PHP SDK for WordPress, and plugin updates served from releases | `sdk/php` |
| ⏳ | **M8** Hardening: expiry reminders, abuse flags, load tests, production deploy | |

---

## 🚢 Deployment

Two processes, and the worker is not optional. Every webhook, email and scheduled job goes through
the queue:

```bash
node ace migration:run --force   # release phase
node bin/server.js               # web
node ace queue:work              # worker
```

Or the whole stack with Docker:

```bash
docker compose up --build
docker compose run --rm web node ace migration:run --force
```

Before going live, set `LICENSE_SIGNING_KEY` and keep a copy somewhere safe. Also keep `APP_KEY`
stable: it decrypts every stored license key.

📘 [`docs/deployment.md`](./docs/deployment.md) · 🔐 [`docs/security.md`](./docs/security.md)

✅ CI runs lint, typecheck and the full suite against **both** SQLite and PostgreSQL, and builds the
image on every push.

---

<div align="center">

Built with 🅰️ [AdonisJS](https://adonisjs.com) on the
[kitch4nSinkV2](https://github.com/IvanWasHere/kitch4nSinkV2) starter ·
📓 read [`plan.md`](./plan.md) for the reasoning behind every decision

</div>
