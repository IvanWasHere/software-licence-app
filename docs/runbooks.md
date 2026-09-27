---
title: Runbooks
nav_order: 15
---

# Runbooks

What to do, step by step, for the things that happen to a running license server. Every command
assumes the VPS layout from [`deployment.md`](./deployment.md#a-vps-with-docker-compose): the
repository at `/srv/licence-app`, run from `deploy/`.

```bash
cd /srv/licence-app/deploy
alias dc='docker compose'
```

---

## Ship a new version

```bash
cd /srv/licence-app && git fetch && git checkout <tag-or-sha>
cd deploy
IMAGE_TAG=$(git rev-parse --short HEAD) docker compose up -d --build
```

`migrate` runs first and `web`/`worker` wait for it. Migrations are additive, so the old version
keeps working against the new schema while the new one starts. Watch it come up:

```bash
dc ps                      # migrate: exited (0); everything else: running/healthy
dc logs -f --tail=50 web
curl -fsS https://$DOMAIN/health
dc exec web curl -fsS localhost:3333/ready   # database, storage and signing: ok
```

**Roll back:** check out the previous tag and run the same command. Because migrations are
additive, the old code runs against the new schema. Never run a down-migration in production.

---

## The license API is down

Customers' software **keeps working**. The SDKs fall back to the last signed answer for the
product's `offline_grace_days` (7 by default). You have days, not minutes. Don't make it worse by
rushing.

1. `curl -fsS https://$DOMAIN/health`
   - Fails: check `dc ps` and `dc logs caddy web`.
   - Passes: `dc exec web curl -s localhost:3333/ready` shows which dependency is down.
2. **`signing: unavailable`** means `LICENSE_SIGNING_KEY` is missing or malformed. Restore it
   from your offline copy (see _Rotate the signing key_). Never generate a new one to get going
   again: every installed SDK pins the old public key and would reject every answer.
3. **`database: unreachable`**: run `dc logs postgres`, and check the disk isn't full (`df -h`).
   `dc restart postgres` is safe.
4. Once it answers again, SDKs catch up on their next check. There is nothing to replay.

---

## A webhook never applied (a customer paid and has no key)

1. **Back-office → Webhooks**: find the event. If it failed, read the error and fix the cause.
   Then press _Replay_, or run `dc exec web node ace billing:replay --failed`.
2. If Creem never delivered it, run `dc exec web node ace billing:sync --dry-run`. It shows every
   subscription that disagrees with Creem. Without `--dry-run` it corrects what would cut a
   customer short: a status, a missed renewal, or a license expiring early. The same sync runs
   nightly.
3. As a last resort, issue the license by hand (**Licenses → Issue a license**) with the order
   number in the note.

---

## A license was flagged

The hourly job flags keys that look shared and emails every admin. It changes nothing; you decide.

1. Open the license from the email or from **Licenses → Flagged only**.
2. Read the activations table and the history:
   - **Many addresses:** an agency with a build farm, or one key on a forum? Check the hostnames
     of the activations.
   - **Activation churn:** installations appearing and disappearing — the signature of a key
     being passed around.
   - **Many dev sites:** on a product where dev sites are free, a leaked key shows up as dozens
     of "staging" hosts.
3. Then pick one:
   - It's legitimate: **Resolve** with a note ("agency, 40 client sites"). Consider raising the
     plan's activation limit for them.
   - It's leaked: **Reissue key**. The old key stops working at once and the customer gets the new
     one from their portal. Only **Suspend** or **Revoke** when it's the customer themselves.
4. A resolved flag is not raised again for the same day. If it reappears on another day, the
   pattern is ongoing.

The thresholds are in `config/licensing.ts` (`abuse`) and grow with each license's size.

---

## A customer wants their receipt

Every successful charge has a numbered receipt PDF (`R-2026-000042`), emailed when the payment
landed and kept under _Billing → Transaction history_ in their account. They want it again, or
the email never arrived:

1. Open the order (_Orders_, or the customer's page) and use **Download the PDF** beside the
   payment. Send it to them, or tell them where it is in their account.
2. They want a _tax invoice_ with VAT: that is Creem's, from **Manage payment & invoices** in
   their account, which opens Creem's portal. Our receipt says so at the bottom.
3. They want a different name or address on it: the receipt reads the account name. Change it
   under _Settings_, download again; the PDF is drawn from the current row.

---

## Rotate the signing key

Every installed SDK pins the public key it was built with. A rotation therefore takes as long as
your customers take to update, and must be done in this order:

1. **Generate** the next key (on a laptop, not the server): `node ace licensing:keygen`. Store both
   halves in your password manager. Say it's `k2`.
2. **Announce** it. In `deploy/.env`, set
   `LICENSE_SIGNING_EXTRA_PUBLIC_KEYS=k2:<public key>`, then `dc up -d web`.
   `GET /api/v1/keys` now lists `k1` (active) and `k2`.
3. **Ship** SDK builds that pin both: `publicKey: { k1: '…', k2: '…' }` in JS,
   `'public_key' => ['k1' => '…', 'k2' => '…']` in PHP. Then wait until the versions in use
   (**Licenses → activations → Version**) are ones that pin `k2`.
4. **Switch**: `LICENSE_SIGNING_KEY=<k2 private>`, `LICENSE_SIGNING_KEY_ID=k2`,
   `LICENSE_SIGNING_EXTRA_PUBLIC_KEYS=k1:<k1 public>`, then `dc up -d web`.
5. After another release cycle, drop `k1` from builds and from the extra keys.

A client that only pins `k1` stops trusting answers at step 4. It then works offline for its grace
period and reports `offline_grace_expired`. That is why step 3 comes first and takes a while.

**If the private key leaked:** do the same steps, but compressed into days, and tell customers to
update. A leaked signing key lets anyone forge "valid" answers for software that trusts it.

---

## Restore a backup

Backups run nightly at `BACKUP_AT` (UTC) into the `backups` volume, and to `BACKUP_REMOTE` when it
is set.

```bash
dc exec backup ls -lh /backups                  # what you have
dc exec backup backup.sh                        # a fresh one first, always
dc stop web worker scheduler
dc exec backup restore.sh /backups/db-20260926-023000.dump
dc up -d
```

To restore from off-site, copy the file into the volume first:
`dc exec backup rclone copy $BACKUP_REMOTE/db-….dump /backups/`.

**Rehearse this.** Restore last night's dump into a scratch database once a quarter, and on the
day you set the server up:

```bash
dc exec postgres createdb -U licence restore_test
dc exec backup pg_restore --no-owner -d restore_test /backups/db-….dump
dc exec postgres psql -U licence -d restore_test -c 'select count(*) from licenses'
dc exec postgres dropdb -U licence restore_test
```

Uploads (release zips) are on R2 with bucket versioning. With `DRIVE_DISK=fs` they are in each
night's `uploads-….tar.gz`.

---

## It is getting slow

The M8 load test put one web process on a laptop at **p95 7 ms at 400 validations a second**,
saturating around 580/s, with the database-backed rate limiter. Real traffic is far lower, because
SDKs cache for `validation_interval_hours`.

1. Measure before changing anything, against staging or a copy:
   `node ace licensing:load-fixture` on the copy, then
   `node scripts/load/validate.mjs --url=https://staging…/api/v1 --rate=200`.
2. First, a bigger machine. Postgres and Node on the same box share CPU; more cores help both.
3. Then `LIMITER_STORE=memory` if the `rate_limits` table is the hot spot. The limits then hold per
   process, which is the same thing with one web process.
4. More web processes need a Redis-backed limiter and a load balancer. That is the point to
   revisit this document.

---

## Someone needs access to the back-office

```bash
dc exec web node ace staff:create --role=support    # or --role=admin
```

Two-factor enrolment is forced on first sign-in. With `ADMIN_IP_ALLOWLIST` set, they must also be
on an allowed address. To remove access, disable the account under **Staff**. Their session ends
on its next request.
