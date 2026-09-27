---
title: Deployment
nav_order: 13
---

# Deploying this application

Two processes, one database, one object store, one mail provider. Nothing here needs Kubernetes,
and nothing here stops you using it.

---

## The shape of it

```
                    ┌──────────────┐
   HTTPS ──────────▶│ web          │  node bin/server.js
                    │ (N replicas) │  stateless; scale horizontally
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐        ┌────────────────┐
                    │ Postgres     │◀───────│ worker         │  node ace queue:work
                    │ jobs + data  │        │ (1+ replicas)  │
                    └──────────────┘        └────────────────┘
                           │                         │
                    ┌──────▼───────┐         ┌───────▼────────┐
                    │ R2 / S3      │         │ Resend         │
                    └──────────────┘         └────────────────┘
```

**The worker is not optional.** Every email, every payment webhook and every scheduled job goes
through the `jobs` table (§9). An application deployed without a worker accepts work it will never
do: signups get no confirmation email, subscriptions never activate, and nothing anywhere reports
an error — the rows simply sit there.

---

## The release

```bash
node ace migration:run --force          # release phase, before the new version serves traffic
node bin/server.js                      # web
node ace queue:work                     # worker
```

Migrations are additive and run before the new code starts, so a rollback does not require a
down-migration. If a change cannot be made that way — dropping a column that the old version still
writes — do it in two releases.

Both processes shut down on `SIGTERM`: the web process stops accepting connections and finishes
what it is serving, the worker finishes the job in its hand and stops claiming new ones. Give them
a grace period of at least 30 seconds, or a long job is killed mid-flight and reclaimed later by
its lease.

---

## A VPS with Docker Compose

The supported production setup (licence plan M8): one Linux machine running
[`deploy/compose.yaml`](../deploy/compose.yaml). **Caddy** terminates HTTPS and gets its own
certificates. Also in the stack: the **web** process, the **worker**, a **scheduler** that queues
the timed jobs, **Postgres**, and a **backup** container that dumps the database nightly and copies
it off the machine. Two cores and 4 GB is plenty to start with (see _It is getting slow_ in the
[runbooks](./runbooks.md)).

**The first deploy:**

1. A machine with Docker and the Compose plugin, a firewall allowing 22, 80 and 443, and the
   domain's A/AAAA records pointing at it.
2. `git clone` the repository to `/srv/licence-app`.
3. `cd deploy && cp .env.example .env && chmod 600 .env`, then fill it in:
   - `APP_KEY`: `node ace generate:key --show`, run on a laptop.
   - `LICENSE_SIGNING_KEY`: `node ace licensing:keygen`. **Keep an offline copy of both halves.**
     Losing it means every installed copy of your software stops trusting the server.
   - `POSTGRES_PASSWORD`: `openssl rand -hex 24`.
   - Creem, Resend and R2 credentials, and `ADMIN_IP_ALLOWLIST`.
   - `COMPANY_*`: what the receipt PDFs say your company is.
   - `BACKUP_REMOTE` and its `RCLONE_CONFIG_*`, so backups leave the machine.
4. `docker compose up -d --build`. `migrate` runs and exits, then everything else starts. Caddy
   fetches a certificate on the first request.
5. `docker compose exec web node ace staff:create --role=admin`.
6. In Creem, point the webhook at `https://$DOMAIN/webhooks/creem`, with the secret from `.env`.
7. Take a backup and restore it into a scratch database (runbooks, _Restore a backup_).
8. Pin the public key from `https://$DOMAIN/api/v1/keys` in your SDK builds.

The scheduler runs `schedule:run` at the intervals below, in UTC:

| Interval        | Queues                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| every 5 minutes | (reserved; nothing is on it yet)                                                                                          |
| hourly          | abuse flags (`detect_license_abuse`)                                                                                      |
| daily, 03:00    | expiry reminders, billing reconciliation, file purge, audit and announcement pruning, invitation expiry, API usage rollup |

Updates, rollbacks, restores and key rotation are in [`runbooks.md`](./runbooks.md).

---

## The image

`Dockerfile` builds it; `compose.yaml` runs the whole stack locally the way it runs deployed.

```bash
docker compose up --build
docker compose run --rm web node ace migration:run --force
```

The image is multi-stage — the compiler and the dev dependencies never reach the runtime layer —
and runs as the unprivileged `node` user. It contains no configuration: everything comes from the
environment, so the same image is what you promote from staging to production.

One image, two commands:

```bash
docker run … your-image                                # web   (default CMD)
docker run … your-image node ace queue:work            # worker
```

---

## Configuration

`.env.example` is the complete list. The ones that decide whether a deployment is correct rather
than merely running:

| Variable                                                             | Set it to                                                        | What breaks otherwise                                                                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_KEY`                                                            | `node ace generate:key`, kept secret, **never rotated casually** | Rotating it invalidates every session and every signed URL in flight                                                                           |
| `APP_URL`                                                            | the public HTTPS URL                                             | Links in email point at the wrong host                                                                                                         |
| `DB_CONNECTION`                                                      | `postgres`                                                       | SQLite on a container filesystem is a database that disappears on the next deploy                                                              |
| `DB_SSL`                                                             | `true` for a managed database                                    | Traffic to your database is in the clear                                                                                                       |
| `TRUST_PROXY`                                                        | `true` **iff** a proxy you control is in front                   | Every rate limit shares one bucket, and the audit trail records the load balancer                                                              |
| `DRIVE_DISK`                                                         | `r2`                                                             | Uploads land on a container filesystem and vanish with it                                                                                      |
| `MAIL_MAILER`                                                        | `resend`                                                         | Mail is queued and never delivered                                                                                                             |
| `SESSION_DRIVER`                                                     | `cookie`, or `database` if you need server-side revocation       | —                                                                                                                                              |
| `ADMIN_IP_ALLOWLIST`                                                 | your office or VPN ranges                                        | The back-office login is reachable from anywhere (it is still behind a separate guard and mandatory 2FA)                                       |
| `LICENSE_SIGNING_KEY`                                                | `node ace licensing:keygen`, backed up offline                   | `/ready` fails and every license answer is a 500. A _new_ key makes every installed SDK reject the server (runbooks, _Rotate the signing key_) |
| `LICENSE_SIGNING_EXTRA_PUBLIC_KEYS`                                  | only during a rotation                                           | —                                                                                                                                              |
| `LICENSE_API_RATE_PER_ADDRESS` / `_PER_KEY`                          | defaults 120 / 30 per minute                                     | —                                                                                                                                              |
| `COMPANY_NAME`, `COMPANY_ADDRESS`, `COMPANY_EMAIL`, `COMPANY_TAX_ID` | your company, as it should read on a receipt                     | Receipt PDFs say `APP_NAME` and the mail sender, with no address                                                                               |

Secrets are declared with `Env.schema.secret()`, so they cannot be logged or serialised by
accident. Where your platform mounts secrets as files, the `file:` prefix reads them from disk.

---

## Health checks

| Endpoint  | Question                | Point it at                                                                                                                                                                             |
| --------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health` | Is this process alive?  | The **restart** probe. It touches nothing else.                                                                                                                                         |
| `/ready`  | Can it serve a request? | The **load-balancer** probe. Checks the database, the object store and the response-signing key, and answers `503` with which one failed. The VPS Caddyfile hides it from the internet. |

Do not wire a dependency check into the restart probe. A brief database blip then becomes every web
process being killed at once, which turns a blip into an outage.

---

## Behind a proxy

Terminate TLS at the proxy, forward to `PORT`, and set `TRUST_PROXY=true`.

That trusts exactly **one** hop — the peer that connected to us, and so the last address it
recorded — which is the safe reading of a header the client can also send. If you have two proxies
in front (a CDN ahead of a load balancer), one hop is one short and `request.ip()` becomes the load
balancer's address; `config/app.ts` says which line to change, and it has to match your topology
exactly, because every hop trusted beyond the real ones is a hop a client can forge.

HSTS is sent with a 180-day max-age (`config/shield.ts`), so serve HTTPS on the whole domain before
the first request — a browser that receives it will refuse plain HTTP for the domain for that long,
including for anything else you host there.

---

## Backups and retention

- **Postgres**: nightly `pg_dump`. The VPS stack's `backup` container does it and copies it off the
  machine (runbooks, _Restore a backup_). Restore one before you need to: a backup that has never
  been restored is a hypothesis.
- **Object storage**: enable bucket versioning. It holds the release zips customers download.
  Deleted files are soft-deleted for 30 days and then hard-deleted by `PurgeDeletedFilesJob`
  (§10); versioning covers the window after that.
- **`webhook_events`** is the billing audit trail. Keep it as long as you keep invoices.
- **`license_events`** is each license's history, and **`license_api_days`** the traffic per day.
  Both are small; keep them. **`license_ip_days`** holds hashed addresses and is pruned after 30
  days by the abuse job.
- The scheduled jobs are _dispatched_ by `node ace schedule:run`, which takes the schedule to run
  as a flag. The VPS stack's scheduler container does this. Elsewhere, cron:

  ```cron
  */5 * * * *  cd /app && node ace schedule:run --interval=5m
  0    * * * *  cd /app && node ace schedule:run --interval=hourly
  0 3  * * *   cd /app && node ace schedule:run --interval=daily
  ```

---

## Watching it

Logs are structured JSON on stdout, with a request id on every line. Ship them somewhere
searchable; the id is what makes an error report actionable, because the API hands the same id to
the client when something goes wrong.

Worth alerting on:

| Signal                        | Query                                                                      | Why                                                                  |
| ----------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Failed jobs                   | `jobs` where `failed_at` is not null                                       | A failing job is a missing email or an unapplied subscription change |
| Webhook backlog               | `webhook_events` where `processed_at` is null and older than a few minutes | Billing is not applying                                              |
| Billing drift                 | the nightly `billing:sync` report                                          | The provider and this database disagree about who is paying          |
| Open abuse flags              | the dashboard, or the email to admins                                      | A key may be shared                                                  |
| License API refusals          | the dashboard's _Refused, 7 days_                                          | A jump means a broken client release, or someone trying keys         |
| `5xx` rate, `/ready` failures | —                                                                          | The usual                                                            |

---

## A checklist for the first deploy

1. `APP_KEY` generated and stored as a secret; `APP_URL` is the public HTTPS URL.
2. `DB_CONNECTION=postgres`, `DB_SSL=true`, migrations run in the release phase.
3. A worker process is running, and it is being restarted the same way the web process is.
4. `node ace schedule:run` is on cron for each interval (see above).
5. `DRIVE_DISK=r2` with a bucket that is **not** public, plus a custom domain for the public disk.
6. `MAIL_MAILER=resend` with a domain verified by SPF and DKIM — until then only
   `onboarding@resend.dev` delivers, and only to yourself.
7. The Creem webhook points at `https://your-app/webhooks/creem`, with a secret that is not the one
   from staging.
8. `TRUST_PROXY` matches reality.
9. `ADMIN_IP_ALLOWLIST` set, and a staff account created with `node ace staff:create` — its
   two-factor enrolment is mandatory.
10. `/health` and `/ready` wired to the right probes.
11. Backups scheduled, copied off the machine, and one restored.
12. `LICENSE_SIGNING_KEY` set, backed up offline, and its public key pinned in the SDK builds.
13. Read [`security.md`](./security.md) once, with your deployment in front of you.
