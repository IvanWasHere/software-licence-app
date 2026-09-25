---
title: The license API
nav_order: 8
---

# The license API

What our software calls to ask "is this license good?" (licence plan §6). It is a different API
from the organisation API in [The API](./api.md), and the two must not be confused:

| | License API | Organisation API |
|---|---|---|
| Called by | plugins and apps on customers' machines | servers we or customers control |
| Authenticated by | product slug + license key in the body | `Authorization: Bearer sk_live_…` |
| CORS | any origin, no credentials | none |
| Routes | `start/routes/license_api.ts` | `start/routes/api.ts` |

The full contract is in `/docs` under the *License API* tag, generated from
`app/licensing/openapi.ts`.

## The rules clients rely on

- **An invalid license is `200`, not an error.** The body says `valid: false` and a `reason`.
  A `4xx` only ever means the request was malformed (`422 validation_failed`) or too frequent
  (`429 rate_limit_exceeded`, with `Retry-After`). SDKs branch on `reason`, never on the status.
- **Reason codes are permanent.** `invalid_license`, `product_mismatch`, `license_revoked`,
  `license_suspended`, `license_expired`, `subscription_inactive`, `not_activated`,
  `activation_limit_reached`. They are compiled into software we can never update, so one is
  never renamed or reused — `tests/unit/licensing.spec.ts` pins the list.
- **Every answer is signed.** `signed.payload` is base64url of the exact JSON bytes that were
  signed with Ed25519; verify `signed.signature` over those bytes with the key from `GET /keys`,
  then parse them. Trust nothing outside `payload`. The request's `product`, `instance_id` and
  `nonce` are echoed inside it, so a signed "valid" cannot be replayed as the answer to another
  product, installation or request.
- **Activation is idempotent** per `instance_id`: a retry costs the customer no slot.
- **Keys are read forgivingly**: case, dashes and whitespace do not matter, and in the random
  part `O` reads as `0`, `I`/`L` as `1`.

## Rate limits

Defined in `start/limiter.ts`:

- **120 a minute per address** — generous, because one address is often a shared host running
  hundreds of sites.
- **30 a minute per license key** on validate, activate and deactivate — a key validated that
  often is a client in a loop or a leaked key; either way it should not cost its neighbours.

SDKs cache for the product's `validation_interval_hours`, so real traffic is far below both.

## A walkthrough with curl

Issue a license in the back-office (`/admin/licenses/new`) and copy the key. The product must
exist; its slug is what you send. Locally, responses are signed with a throwaway key per process
unless `LICENSE_SIGNING_KEY` is set (`node ace licensing:keygen` prints one).

```bash
BASE=http://localhost:3333/api/v1
KEY=WIPRO-XXXXX-XXXXX-XXXXX-XXXXX
```

**Is the key good?**

```bash
curl -s $BASE/licenses/validate -H 'content-type: application/json' \
  -d "{\"product\":\"invoice-pro\",\"license_key\":\"$KEY\"}" | jq '{valid, reason, license, entitlements}'
```

**Activate this installation** — `instance_id` is generated once by the client and kept:

```bash
curl -s $BASE/licenses/activate -H 'content-type: application/json' \
  -d "{\"product\":\"invoice-pro\",\"license_key\":\"$KEY\",\"instance_id\":\"4f7c…\",\"site_url\":\"https://shop.example.com\",\"client_version\":\"1.4.0\"}" \
  | jq '{activated, reason, activation, license: .license.activations}'
```

At the limit the answer is `activated: false`, `reason: "activation_limit_reached"` and the
numbers in `license.activations`. Development hostnames (`localhost`, `*.test`, `staging.*`, …
see `config/licensing.ts`) do not count unless the product is set to count them.

**Is this installation activated?** — the call a client makes on its schedule:

```bash
curl -s $BASE/licenses/validate -H 'content-type: application/json' \
  -d "{\"product\":\"invoice-pro\",\"license_key\":\"$KEY\",\"instance_id\":\"4f7c…\",\"nonce\":\"$(uuidgen)\"}" \
  | jq '{valid, reason, activation, policy}'
```

This also refreshes the activation's *last seen*, at most once an hour.

**Release the slot:**

```bash
curl -s $BASE/licenses/deactivate -H 'content-type: application/json' \
  -d "{\"product\":\"invoice-pro\",\"license_key\":\"$KEY\",\"instance_id\":\"4f7c…\"}" | jq
```

Works for an expired or suspended license too. `deactivated: false` with a null reason means it
was not active.

**Check a signature by hand:**

```bash
RESPONSE=$(curl -s $BASE/licenses/validate -H 'content-type: application/json' \
  -d "{\"product\":\"invoice-pro\",\"license_key\":\"$KEY\"}")
echo "$RESPONSE" | jq -r .signed.payload | tr '_-' '/+' | base64 -d 2>/dev/null | jq
curl -s $BASE/keys | jq
```

**The product, without a key:**

```bash
curl -s $BASE/products/invoice-pro | jq
```

Draft products answer `404`; retired ones are described but list no plans.

## Where things live

| | |
|---|---|
| Controllers | `app/controllers/api/v1/license_controller.ts`, `product_controller.ts` |
| Response shapes | `app/licensing/api_payload.ts` |
| Decision rules | `app/licensing/validation.ts` (pure), `license_service.ts`, `activation_service.ts` |
| Signing | `app/licensing/signer.ts`, `config/licensing.ts` |
| CORS, request id, preflight | `app/middleware/license_api.ts` |
| Tests | `tests/functional/license_api/`, `tests/unit/licensing.spec.ts` |
| JS SDK | [`sdk/js`](../sdk/js) — and its contract test against this API, `tests/functional/sdk/` |
