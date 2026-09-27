#!/bin/sh
# Restore a backup into the running Postgres (docs/runbooks.md, "Restore").
#
#   docker compose stop web worker scheduler
#   docker compose exec backup restore.sh /backups/db-20260926-023000.dump
#   docker compose up -d
#
# Replaces every table in the database with the dump's. There is no undo —
# take a fresh backup first (`docker compose exec backup backup.sh`).
set -eu

file="${1:?usage: restore.sh /backups/db-YYYYmmdd-HHMMSS.dump}"

echo "restore: replacing database $PGDATABASE with $file in 5 seconds — Ctrl-C to stop"
sleep 5

pg_restore --clean --if-exists --no-owner --single-transaction --dbname="$PGDATABASE" "$file"
echo "restore: done. Start web, worker and scheduler again."
