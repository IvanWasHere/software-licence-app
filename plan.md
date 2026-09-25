# Licence App — Implementation Plan

A self-hosted **license and commerce server** for one company that sells several software products (WordPress plugins, desktop/web apps, JS libraries). Customers buy a plan, either one-time or recurring, and receive a license key. The software checks that key through a small public API or through our PHP or JS SDK.

This is **not a SaaS.** It is one deployment for one company. Products are rows in the database, so adding a product needs no code changes.

The server is a fork of [`kitch4nSinkV2`](../kitch4nSinkV2) (AdonisJS 7). This plan replaces `old-plan.md`. It keeps that document's ideas but builds on what the starter actually has. The chat transcript assumed a Stripe provider and a DB-driven plan system; neither exists.

---

## 1. Goals and non-goals

**Goals**
- Define many **products**, each with **plans** (monthly, yearly, lifetime, and so on) and **entitlements** (feature flags), all as data.
- Support **one-time** purchases, which produce perpetual licenses with optional `updates_until`/`support_until` dates.
- Support **recurring** purchases, where the subscription drives the license expiry.
- Provide a public license API with `validate`, `activate`, `deactivate` and `releases/latest`, plus stable reason codes.
- Provide a **customer portal** where the customer logs in to see licenses, manage activations, see invoices and open the billing portal.
- Provide a **staff back-office** to manage products, plans, customers, licenses, activations, payments, webhooks and the audit log.
- Ship a **tiny JS SDK** (zero dependencies, customizable) and a **PHP SDK** for WordPress, with caching and an offline grace period.
- Serve WordPress plugin updates behind license checks.

**Non-goals (v1)**
- Multi-company or SaaS tenancy.
- More than one payment provider. Creem is already implemented; the `PaymentProvider` boundary stays in place for later providers.
- Tax and invoicing beyond what the provider does. Creem is merchant of record.
- Usage-based or metered billing, floating/concurrent licenses, hardware fingerprinting.

---

## 2. What we reuse from kitch4nSinkV2

| Area | Starter has | Plan |
|---|---|---|
| Stack | Node 24, Adonis 7, Lucid, VineJS, Edge + Alpine + Vite, Japa | Keep as is |
| DB | SQLite (dev), Postgres (prod) | Keep; write migrations that work on both |
| Staff auth | `staff` guard, `staff_users`, mandatory 2FA, IP allowlist, impersonation | Keep; this becomes the back-office |
| Customer auth | `web` guard, email verify, reset, TOTP 2FA, social login | Keep; this becomes the customer portal |
| API keys | `sk_live_…`, SHA-256 hash, scope registry, rate-limit and usage middleware | Keep for **server-to-server** integrations |
| Payments | `PaymentProvider` in `app/billing/contracts.ts`, Creem provider, test fake | Keep; extend for one-time checkout and product/price mapping |
| Webhooks | `webhook_events` ledger (unique `provider_event_id`), `process_webhook_job`, replay command and admin UI | Keep; add license side-effects to the handler |
| Queue | DB-backed queue, `queue_work`, `schedule_run` | Keep; add licensing jobs |
| Mail, audit, limiter, OpenAPI, `/health`, Docker, CI | Present | Keep; extend `AUDIT_ACTIONS`, scopes and OpenAPI |

**Replace, not delete up front.** Core test suites (tenant isolation, API endpoints, quotas) use the lists demo as their example of a customer-owned resource, and `docs/modules.md` warns that deleting it first loses that coverage. So the SaaS-only pieces go only once their replacement exists:
- The `app/modules/lists/` demo module goes in **M5**. It was planned for M2, but the suites that use it test customer-facing web and API endpoints, and licenses only get those in the portal (M5). Then licenses become the customer-owned resource in `tests/helpers.ts#createList` and `tenant_isolation.spec.ts`. Follow `docs/modules.md` steps 1–4.
- Quotas and seats go in **M5** together with lists, because lists are the only thing they meter.
- The static SaaS tiers in `config/plans.ts` (`organization.planKey`, `PlanService` limits) go in **M4**, when billing is reworked:
  - Plans move to the DB (§4).
  - A customer account no longer has a single tier. It holds any number of licenses and subscriptions.
  - The API-key allowance moves to a flag on the org.

**Keep** (decided in M0):
- **Support tickets:** a licensing business answers "where is my key / free up a site" questions.
- **Notifications and announcements:** release announcements to customers.
- **Files/storage:** M7's release uploads reuse the drive disks.
- **Invitations and members:** see D1.

The starter's own design doc is kept as `server/STARTER_PLAN.md`, because its code comments cite "plan §…".

### Decision D1: what "organization" becomes

Tenancy runs through about 96 files and 14 migrations, so tearing it out costs a lot for no benefit. Instead:

> **Treat `organizations` as the customer account, meaning the billing entity.** The company running the server is the deployment itself. Its people are `staff_users`.

This fits what already exists:
- `subscriptions`, `payments`, `api_keys` and `audit_logs` are already keyed by `organization_id`, which gives per-customer isolation for free. `tenant_isolation.spec.ts` keeps protecting it.
- A customer who signs up gets a personal org, as the starter already does.
- An agency customer can later invite team members through the existing invitations code, which is why we defer rather than delete it.
- In the UI we call it a **customer account**. The table is not renamed, to avoid churn. The org model gets a `CustomerAccount` alias type.

Integration keys for our own marketing site and backend (`sk_live_…`) belong to a single **system org** seeded at install time, with scopes such as `checkout:write` and `licenses:read`.

---

## 3. Architecture

```
                  Staff back-office (Edge)     Customer portal (Edge)
                             │                           │
                             ▼                           ▼
┌───────────────────────────────────────────────────────────────────────┐
│ AdonisJS server                                                       │
│  app/catalog/    products, plans, entitlements, releases              │
│  app/licensing/  keys, validation, activation, state, signing         │
│  app/billing/    checkout, provider (Creem), webhook → license effects│
│  app/api/        API keys, scopes, OpenAPI                            │
│  queue jobs · audit log · mail · limiter                              │
└───────┬───────────────────────────────┬───────────────────────────────┘
        │ /api/v1/licenses/*            │ /api/v1/checkout, /orders …
        │ (license key auth, public)    │ (sk_live_ key auth, server-side)
        ▼                               ▼
   PHP SDK (WordPress)            Our website backend
   JS SDK (browser/Node/Electron)
                                        ▲
                     Creem ── webhooks ─┘ /webhooks/creem
```

The API has two surfaces, and they must not be mixed:
1. **License API** (`/api/v1/licenses/*`, `/api/v1/products/:slug/releases/*`). Public. A request authenticates with **product slug + license key**. No API key and no user login. It is rate-limited by IP and by key hash. This is the only surface SDKs call.
2. **Integration API** (`/api/v1/checkout`, `/orders`, `/customers/…`). Requires an `sk_live_` key with scopes, and is called only from servers we control. It uses the starter's existing `apiKeyAuth` + `apiRateLimit` + `trackApiUsage` group.

Webhooks stay under `/webhooks/creem`, as in the existing `webhook_controller.ts`.

---

## 4. Data model

New tables. Every table has `id`, a `public_id` (nanoid, used in URLs and the API) and timestamps. The starter's portability rules in `server/CONTRIBUTING.md` apply:
- Money is stored as integer `_cents` columns plus `currency`.
- JSON goes through `table.json()` and the `jsonColumn` decorator.
- No partial indexes, no column alters, no raw SQL. Uniqueness that depends on a row's state is enforced in a service behind a row lock.

**Catalog**
The first three tables were **built in M1**:
- `products`: `slug` (unique, used by SDKs), `name`, `description`, `status` (`draft|active|retired`), `kind` (`wordpress_plugin|app|library|other`), `key_prefix` (e.g. `WIPRO`), `homepage_url`, `docs_url`, plus three columns that make up the SDK policy:
  - `validation_interval_hours` (default 24)
  - `offline_grace_days` (default 7)
  - `count_dev_sites` (default false; see §5.4)
- `plans`:
  - Identity and status: `product_id`, `slug` (unique per product), `name`, `status` (`active|archived`), `is_public`, `sort_order`.
  - Money: `billing` (`one_time|monthly|yearly`), `price_cents`, `currency`.
  - License: `license_term` (`perpetual|subscription|fixed_days`), `term_days`, `updates_days` (perpetual only; null means forever).
  - Limits: `max_activations` (**lives on the plan only**; null means unlimited).
  - Provider: `provider_product_id` (unique; the Creem product).
  - `entitlements`: a json map from key to value. It replaces the `plan_entitlements` join table.
- `entitlements`: `product_id`, `key` (e.g. `pdf_export`; unique per product), `name`, `type` (`boolean|integer|string`), `default_value`, `description`.

**Catalog rules** (in `CatalogService`):
- **Permanent once shipped.** Product and plan slugs, and a plan's billing and license term, can change only while the product is `draft`. A product never returns to draft.
- **Price is editable any time.** Licenses copy what they need when they are issued.
- **Entitlement key and type are permanent.** Deleting a definition also removes its value from every plan.
- **Resolution order:** license override → plan value → definition default → the type's zero value. The pure function is `#catalog/entitlements.resolveEntitlements`.
- **Retiring** a product takes it off sale. Existing licenses keep validating.
- **SDK `on_invalid` hints** are deferred to M6, when the SDK needs them.
- `releases`: `product_id`, `version` (semver), `channel` (`stable|beta`), `changelog` (md), `requires` (json, e.g. `{wp:"6.5",php:"8.1"}`), `file_key` (drive/S3 path), `checksum_sha256`, `published_at`, `license_required`.

**Commerce.** Customers are orgs (D1).
- `orders`: `organization_id`, `status` (`pending|paid|refunded|partially_refunded|failed`), `total_cents`, `currency`, `provider`, `provider_checkout_id`, `provider_order_id`, `paid_at`.
- `order_items`: `order_id`, `plan_id`, `quantity`, `unit_price_cents`.
- `subscriptions` and `payments`: **existing tables**. Add `plan_id` to both, `order_id` to `payments`, and `cancel_at_period_end` if it is missing.

**Licensing**
These tables were **built in M2**:
- `licenses`, with these column groups:
  - Ownership: `organization_id`, `product_id`, `plan_id`, `subscription_id` (null for one-time), and `source` (`manual|order`). `order_id` arrives with orders in M4.
  - Key: `key_hash` (SHA-256 of the key body, unique, used for lookup), `key_encrypted` (app encryption, so the portal and emails can show it again), `key_suffix` (the last 4 characters).
  - The status group also gains `status_reason`.
  - Status: `status` (`active|suspended|revoked`), `expires_at` (null means perpetual), `updates_until`, `support_until`.
  - Limits and entitlements: `max_activations` (a snapshot from the plan that staff can override), `entitlement_overrides` (json).
  - Other: `notes`.
- `license_activations`: `license_id`, `instance_id` (a UUID generated by the client), `site_url`/`hostname` (normalized), `label`, `is_dev`, `ip`, `user_agent`, `client_version`, `activated_at`, `last_seen_at`, `deactivated_at`. Portability rule 5 forbids partial indexes, so "one live activation per (`license_id`, `instance_id`)" is enforced in `ActivationService` inside a transaction that locks the license row. Re-activating a deactivated instance reuses its row.
- `license_events`: an append-only history.
  - `type` is one of `issued`, `key_reissued`, `key_revealed`, `suspended`, `resumed`, `revoked`, `expiry_changed`, `activations_limit_changed`, `activated`, `reactivated`, `deactivated` (see `#licensing/events`).
  - Each row also has `actor_type` (`system|staff|user|api_key|client`), `actor_id` and `metadata`.
  - It is written in the same transaction as the change it describes. Staff actions also go to the global audit log.

**Why the key is both hashed and encrypted.** This changes `old-plan.md`, where keys were hash-only. Lookup uses the hash, so a DB dump alone does not reveal usable keys to anyone without `APP_KEY`. Customers still lose keys, though, and support then needs to show the key again. Reissuing a key rotates both columns.

**Key format:** `{PREFIX}-XXXXX-XXXXX-XXXXX-XXXXX`, using the Crockford base32 alphabet (no I/L/O/U), which gives 100 bits of entropy.
- Only the 20-character **body** is hashed. The prefix is for humans, and the product check uses the stored row.
- Parsing is forgiving: case, dashes and whitespace are ignored, and in the body `O` reads as `0` and `I`/`L` as `1`.
- The prefix is never rewritten, so `WIPRO` survives.

---

## 5. Licensing engine (`app/licensing/`)

### 5.1 Effective state

The stored `status` holds only what staff or payments set explicitly. Validity is always **computed**, so no cron job has to flip rows exactly on time.

The checks run in this order; the first one that fails decides the reason:

1. No license matches the key hash → `invalid_license`.
2. The license belongs to a different product than the one requested → `product_mismatch`.
3. `status = revoked` → `license_revoked`.
4. `status = suspended` → `license_suspended` (e.g. payment failed, or staff hold).
5. `expires_at < now` → `license_expired`.
6. The license is tied to a subscription whose state is not `active|trialing|past_due within dunning` → `subscription_inactive`.
7. For validate with an `instance_id` that is not activated → `not_activated`.
8. For activate when the limit is reached → `activation_limit_reached`.

Otherwise the result is `valid`. The response also includes `updates_available_until` (for perpetual plans) and the resolved entitlements. Entitlements are plan values merged with `entitlement_overrides`.

Reason codes are **part of the public contract**. They live in one enum, which is exported to both SDKs, and are never renamed.

### 5.2 Services
- **`LicenseService`**
  - Issue a license from an order item.
  - Extend on renewal.
  - Suspend, resume, revoke.
  - Reissue the key.
  - Transfer to another customer (staff only).
  - Every call writes `license_events` and the audit log.
- **`ValidationService`**
  - Implements §5.1 as a pure function over the loaded rows, which makes it easy to unit-test the whole matrix.
- **`ActivationService`**
  - Activate: idempotent for the same `instance_id`.
  - Deactivate, and heartbeat (`last_seen_at` is updated at most once an hour).
  - Mark dev sites.
  - Customers can free up slots from the portal.
- **`ResponseSigner`** (`#licensing/signer`)
  - Signs license API responses with Ed25519. The key pair is in env (`LICENSE_SIGNING_KEY`, `LICENSE_SIGNING_KEY_ID`, generated by `node ace licensing:keygen`), and the raw 32-byte public key is published at `/api/v1/keys`.
  - The key is required in production. Development and tests use a per-process ephemeral key.
  - **The exact JSON bytes are signed** and carried as base64url in the envelope `{ alg, kid, payload, signature }`. SDKs verify those bytes and then parse them, so JS and PHP never have to re-serialise JSON identically.
  - SDKs verify the signature before caching, so an edited local cache or a fake local server cannot unlock the product. This is what makes offline grace safe.

### 5.3 Subscription → license mapping (in `webhook_handler.ts`)

| Normalized event | Effect |
|---|---|
| checkout completed / order paid (one-time) | mark order paid; issue licenses; email the keys |
| subscription created / active | mark order paid; issue a license with `expires_at = current_period_end` |
| subscription renewed / payment succeeded | set `expires_at = new period_end + grace (3 days)` |
| payment failed / past_due | none at first; after the dunning window a job sets `suspended` |
| subscription canceled (at period end) | set `cancel_at_period_end`; the license runs until `expires_at` |
| subscription expired / canceled immediately | set `expires_at = now` |
| refund (full) | revoke the license and mark the order refunded |
| refund (partial) | record it only; staff decide what happens |

Handlers must be idempotent: re-running an event against the ledger must not create a second license. The guard is a unique index on (`order_item_id`, `seq`) for issued licenses.

### 5.4 Dev and staging sites

Hostnames matching `localhost`, `*.local`, `*.test`, `staging.*`, `dev.*` or `*.wpengine.com`-style staging patterns are marked `is_dev`. They don't count toward `max_activations` unless the product sets `count_dev_sites`. The pattern list lives in config.

### 5.5 Scheduled jobs (via `schedule_run`)
- `suspend_past_due_licenses`: runs hourly and applies the dunning rule.
- `license_expiry_reminders`: runs daily and emails 14 and 3 days before a non-renewing license expires.
- `prune_stale_activations`: optional, per product. It flags activations not seen for more than N days; it doesn't delete them.
- `sync_billing`: already exists. Extend it to reconcile subscription period ends with license `expires_at`.

---

## 6. Public API (v1)

All endpoints below are **frozen once shipped**. Changes are additive only; breaking changes go to `/api/v2`, because old plugin installs live for years. Every response includes `request_id` and, on the license API, a `signature`.

**License API** (public, license-key auth, limited by IP and key hash):

```
POST /api/v1/licenses/validate     { product, license_key, instance_id? }
POST /api/v1/licenses/activate     { product, license_key, instance_id, site_url?, label?, client_version? }
POST /api/v1/licenses/deactivate   { product, license_key, instance_id }
GET  /api/v1/products/:slug                         public product info
GET  /api/v1/products/:slug/releases/latest?channel=&license_key=&instance_id=
GET  /api/v1/releases/:id/download?token=           short-lived signed URL
GET  /api/v1/keys                                   response-signing public key(s)
```

`validate` response:

```json
{
  "valid": true,
  "reason": null,
  "license": {
    "status": "active",
    "type": "subscription",
    "expires_at": "2027-09-25T00:00:00Z",
    "updates_until": null,
    "product": "invoice-pro",
    "plan": "invoice-pro-yearly",
    "activations": { "used": 2, "max": 3 }
  },
  "entitlements": { "pdf_export": true, "api": false, "white_label": false },
  "policy": { "validation_interval_hours": 24, "offline_grace_days": 7 },
  "checked_at": "2026-09-25T10:00:00Z",
  "request_id": "req_…",
  "signed": { "alg": "Ed25519", "kid": "k1", "payload": "<base64url of the JSON above>", "signature": "<base64url>" }
}
```

The top-level fields are there for convenience and debugging. SDKs trust only `signed.payload` after verifying it.

An invalid key returns **HTTP 200** with `valid: false` and a `reason`. That is a business answer, not an error. A 4xx is reserved for malformed requests (422) and rate limits (429, with `Retry-After`).

**Integration API** (`sk_live_` + scopes, server-side only):

```
POST /api/v1/checkout                    { plan, email?, customer_id?, success_url, cancel_url } → { checkout_url }
GET  /api/v1/orders/:id
GET  /api/v1/customers/:id/licenses
POST /api/v1/licenses                    manual issue (scope licenses:write), e.g. for comps or partners
POST /api/v1/licenses/:id/{suspend|resume|revoke|reissue}
```

**Customer portal** (session, `web` guard). This is the meaning of "login via API" in the original ask:
- `/account/licenses`: show keys, activations, remove an activation, download releases.
- `/account/billing`: orders and invoices, plus a "Manage subscription" button that calls `createPortalSession`.
- `/pricing/:product` → a checkout redirect. Anonymous checkout creates the customer account from the webhook email and sends a magic "set password" link.

The software itself **never needs a customer login**. It uses the license key and `instance_id`. An optional later addition is a device-login flow, in which the plugin opens the portal, the customer picks a license, and the portal returns the key to the plugin. It is listed under §11.

The OpenAPI spec is extended in `app/api/openapi.ts`, and every new route is documented at `/docs`.

---

## 7. SDKs

Both SDKs share the same behaviour contract. The flow is:
1. Read the cached signed response. If it is fresh (younger than `validation_interval_hours`), use it.
2. Otherwise call `validate`. On success, verify the signature, cache the response and return it.
3. On a network or 5xx error, if the last good response is within `offline_grace_days`, return it with `offline: true`. Otherwise return `valid: false, reason: "offline_grace_expired"`.
4. A definitive `valid: false` from the server is cached too, but only briefly (1h), so a customer who has fixed their billing is unblocked quickly.
5. The SDK **never** kills the host app. It reports state, and the product decides what to lock, guided by the `on_invalid` hint.

### 7.1 JS SDK: `@<org>/license` (`sdk/js`)
- ESM + CJS, TypeScript types, **zero dependencies, under 4 KB gzipped**. Runs in browsers, Node 18+, Electron, Deno and Bun.
- Signature verification uses WebCrypto Ed25519, with a `tweetnacl` fallback that is only loaded when needed.
- API:

  ```ts
  const lic = createLicenseClient({
    baseUrl, product, publicKey,
    storage?,              // localStorage | memory | fs | custom { get, set, remove }
    fetch?,                // injectable
    instanceId?,           // default: generated once and persisted
    onChange?,             // callback when validity/entitlements change
  })
  await lic.activate(key, { label })
  await lic.validate({ force? })
  await lic.deactivate()
  lic.has('pdf_export'); lic.get('max_projects')
  ```

- Security note, stated in the README: the SDK only uses the public license API and holds **no secrets**. In pure browser code any check can be patched out, so for web apps the real gate belongs on the app's own backend (the Node SDK uses the same package).

### 7.2 PHP SDK: `<org>/wp-license` (`sdk/php`)
- Composer package, PHP 7.4+ (WordPress reality), no dependencies beyond WP HTTP.
- Uses `wp_remote_post` with `wp_options` and transients as the cache.
- Includes a drop-in `Updater` that hooks `pre_set_site_transient_update_plugins` and `plugins_api` to serve updates from `releases/latest`.
- Includes a drop-in admin settings page for key entry, activation status and a deactivate button, which products can override.
- Signature verification uses `sodium_crypto_sign_verify_detached`, which is bundled in PHP 7.2+.
- An example plugin in `examples/wp-plugin` exercises everything.

---

## 8. Back-office (staff, Edge views under `/admin`)
- **Products:** CRUD, settings, entitlements, releases (upload to drive, publish, yank).
- **Plans:** CRUD, price, term, activations, entitlement values, and the mapping to a Creem product ID.
- **Customers** (orgs): profile, orders, subscriptions, licenses, activations, audit trail. Impersonation (existing) for support.
- **Licenses:** search by last4, email or order. Staff can issue manually, suspend/resume/revoke, reissue, extend, override activations or entitlements, and view the `license_events` timeline.
- **Activations:** list with last seen, force-deactivate, flag abuse (e.g. more than N distinct IPs per day).
- **Payments and webhooks:** existing ledger and replay UI.
- **API keys:** integration keys for the system org.
- **Dashboard:** active licenses per product, MRR (from subscriptions), new orders, failed webhooks, validate traffic.

All mutating actions go through services, pass the staff policies (`app/admin/staff_policy.ts`) and write the audit log. New `AUDIT_ACTIONS` are added for every license and catalog action.

---

## 9. Security checklist
- License API:
  - Strict Vine validation.
  - Constant-time behaviour: an unknown key and a known key take similar paths.
  - Rate limits of 60/min per IP and 30/min per key hash, both configurable.
  - No CORS credentials; CORS is `*` only on the license API, since it holds no cookies.
- Response signing (Ed25519) with support for key rotation: the `/keys` endpoint lists several keys and each response carries a `kid`.
- Keys are hashed and encrypted. API keys stay hashed as they are in the starter. Creem secrets live in env.
- Webhooks: signature check (exists), ledger with a unique event ID (exists), and effects that are idempotent.
- Download URLs are signed and expire within 10 minutes; they are bound to the license and the release.
- Abuse detection job: flags licenses with too many distinct hostnames or IPs. It flags and notifies staff; nothing is auto-revoked.
- Keep the existing protections: staff 2FA and IP allowlist, shield/CSRF on web routes, security headers.
- Backups: Postgres daily dump plus drive bucket versioning. Documented in `docs/deployment.md`.

---

## 10. Repository layout

```
licence-app/
├── server/            fork of kitch4nSinkV2 (git history preserved)
│   ├── app/catalog/       products, plans, entitlements, releases
│   ├── app/licensing/     license, validation, activation, signer, reason codes
│   ├── app/billing/       (existing) + checkout for plans, license effects
│   ├── app/controllers/api/v1/{licenses,products,releases,checkout,orders}_controller.ts
│   ├── app/controllers/admin/{products,plans,licenses,activations}_controller.ts
│   ├── app/controllers/account/{licenses,billing}_controller.ts
│   └── tests/{unit,functional}/licensing/…
├── sdk/js/            @<org>/license
├── sdk/php/           <org>/wp-license
├── examples/wp-plugin/
├── examples/node-app/
└── docs/              API reference, SDK guides, runbooks
```

Follow the starter's conventions: snake_case files, thin controllers, services do the writes, transformers shape API JSON, routes live in `start/routes/*.ts`, and feature tests live next to their area.

---

## 11. Milestones

Each milestone ends green in CI and can be demoed.

**M0: Fork (≈½ day)** ✅ done
- Import the starter into `server/` with `git subtree`, so its history is preserved.
- Move CI to the repo root with `working-directory: server`. Drop the starter's docs-site workflow. Rename the package.
- Keep support, notifications and files; see §2. Stripping moves into M4 and M5.
- ✅ Typecheck clean, 667/667 unit and functional tests passing.

**M4 and M5 carry the stripping work.**
- M4 moves billing from "one tier per org" to "subscriptions per license".
- M5 replaces the lists demo with licenses and removes quotas and seats.
- The system org for integration keys is seeded in M4, when the integration API arrives.

**M1: Catalog (≈3 days)** ✅ done
- Added the products, entitlements and plans migrations, the models and `#catalog/catalog_service`.
- Staff pages at `/admin/products`. Support can read them; admins can edit (`StaffPolicy.manageCatalog`). Every write is audited.
- Nothing is removed yet; `config/plans.ts` stays until M4.
- ✅ 38 new tests (unit: resolution and plan shape; functional: access, products, plans, entitlements). Suite at 705/705.

**M2: Licensing core (≈4 days)** ✅ done
- Added the `licenses`, `license_activations` and `license_events` tables.
- Pure modules in `app/licensing/`: `keys`, `reasons`, `validation` (the §5.1 rules), `hostnames` (normalising and dev-site detection) and `signer`.
- `LicenseService`: issue, check, entitlements, suspend/resume/revoke, reissue key, reveal, change expiry, set limit, history.
- `ActivationService`: idempotent activate under a row lock on the license, deactivate, reuse of the row when an instance comes back, usage counts and heartbeat.
- Admin pages at `/admin/licenses`:
  - Search by key, suffix, `lic_`/`org_` id or email.
  - Issue by hand.
  - A detail page showing activations, entitlements and history.
  - Support can reveal a key and free an activation slot (`StaffPolicy.assistLicense`).
  - Admins can issue, suspend, resume, revoke, reissue, change expiry and set the limit (`manageLicenses`).
  - The organisation page links to that customer's licenses.
- **Lists removal moved to M5** (see §2).
- ✅ 58 new tests: the full reason-code matrix, key parsing, dev hosts, a signer round-trip and tamper check, the services (including the racing-activation case) and the admin screens. Suite at 764/764.

**M3: License API (≈3 days)** ✅ done
- Built `POST /api/v1/licenses/{validate,activate,deactivate}`, `GET /api/v1/products/:slug` and `GET /api/v1/keys` in their own route group (`start/routes/license_api.ts`), separate from the org API.
- `LicenseApiMiddleware` provides CORS for any origin (no credentials), `x-request-id`, `cache-control: no-store` and the preflight answer.
- Rate limits: 120/min per address and 30/min per license key.
- Every answer is signed. `product`, `instance_id` and an optional client `nonce` are echoed inside the signed payload, so a signed answer can't be replayed for a different product, installation or request.
- The OpenAPI docs use the *License API* tag with `security: []`. There's a walkthrough in `server/docs/license-api.md`.
- ✅ 25 new tests (every endpoint and state, signature round-trip, CORS/preflight, the per-key limit, and the keyless OpenAPI entries). Suite at 789/789.
- Follow-up for M8: the router-level session and shield middleware still set cookies on `/api/*` responses. They're harmless here (never read, and CORS sends no credentials), but they're wasted bytes for every plugin. Exempt `/api/*` from the session middleware during hardening.
- **← First usable MVP**: licenses issued by hand, validated by software.

**M4: Payments → licenses (≈4 days)**
- Add orders and order items. Extend `createCheckoutSession` for one-time plans and plan mapping.
- Map webhook effects per §5.3. Add the dunning job and the email templates (keys, receipts, expiry reminders).
- ✅ With the Creem test mode and the fake provider:
  - A one-time purchase results in a perpetual license.
  - A subscription purchase, renewal, cancellation, refund and failed payment all result in the correct license state.
  - Replaying an event causes no duplicates.

**M5: Customer portal (≈3 days)**
- Build the licenses page (reveal key, manage activations), billing (orders, portal link), a pricing page with checkout, and anonymous checkout with a magic link.
- Remove the lists demo, quotas and seats. Port `createList()`, `tenant_isolation.spec.ts` and the API endpoint suites to licenses (`docs/modules.md` steps 1–4).
- ✅ An end-to-end browser test covers buy → receive email → log in → see key → deactivate a site.

**M6: JS SDK (≈3 days)**
- Build the package with caching, grace period, signature verification, storage adapters and entitlements helpers.
- Add `examples/node-app`.
- ✅ Tests run against a mocked server and against a live local server; size budget enforced in CI.

**M7: PHP SDK and updates (≈5 days)**
- Build releases in the admin (upload/publish), the `releases/latest` and signed download endpoints, and the PHP client, updater and settings page.
- Add `examples/wp-plugin`.
- ✅ In a wp-env Docker environment, the plugin activates, shows its status, gets an update notice and installs the update. Expired keys get no updates but the plugin keeps working.

**M8: Hardening and launch (≈3 days)**
- Add the abuse flags, admin dashboard metrics and backups.
- Load-test validate: target p95 under 50 ms at 200 rps on a single node.
- Security review, production deploy, runbooks.

Total **≈30 working days** for one developer.

**Later:**
- A second payment provider.
- Device-login flow (the plugin opens the portal to pick a license).
- Outbound webhooks to our other systems.
- Coupons, trials, upgrades between plans with proration, and team seats on agency licenses via the existing invitations.

---

## 12. Testing strategy
- **Unit:** the `ValidationService` truth table (state × expiry × subscription × activation), key normalization, dev-site detection, signer round-trip, webhook→effect mapping.
- **Functional (Japa api-client):** every `/api/v1` endpoint per reason code, rate limiting, idempotent webhook replay, and tenant isolation of the customer portal (extend `tenant_isolation.spec.ts`).
- **Browser (Playwright):** the purchase→portal flow and the admin license actions.
- **SDKs:**
  - JS: vitest with a mock `fetch`, a clock and tampered-signature cases.
  - PHP: PHPUnit plus a wp-env smoke test.
- **Contract:** SDK tests run against a real server booted in CI, so the reason codes and response shape can't drift.

---

## 13. Open questions
1. **Company name, key prefixes and package scope.** Replace `<org>` throughout.
2. **Creem fit.** Confirm Creem supports everything we need: one-time and recurring products, the customer portal, refunds and the webhook events in §5.3. Creem may also offer its own license-key feature. If so, we deliberately don't use it, because our server stays the source of truth.
3. **Dunning window and renewal grace.** The proposal is 7 days past_due before suspension and 3 days of renewal grace.
4. **Expired perpetual-update licenses.** Should they still validate as `valid` with `updates_until` in the past (proposed), or return a distinct state?
5. **Activation limits.** Are the defaults per plan right (e.g. 1 / 5 / unlimited sites)? Should dev sites be free?
6. **VAT and invoices.** Is Creem's merchant-of-record invoice enough, or do we need our own invoice PDFs?
7. **Hosting target.** Docker on a VPS with Postgres, per the starter's `compose.yaml`, or somewhere else?
