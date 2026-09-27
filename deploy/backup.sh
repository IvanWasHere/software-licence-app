#!/bin/sh
# Nightly backup (licence plan §9, M8).
#
#   backup.sh           one backup now
#   backup.sh --loop    every day at BACKUP_AT (UTC, default 02:30)
#
# Writes a custom-format pg_dump — restorable table by table — and, when
# DRIVE_DISK=fs, a tarball of the uploads (release zips live there). Keeps
# BACKUP_KEEP_DAYS locally (default 14). When BACKUP_REMOTE is set (an rclone
# remote path, e.g. `r2:licence-backups/db`, configured with RCLONE_CONFIG_*
# variables), each file is copied there too — set a lifecycle rule on that
# bucket for how long to keep them.
#
# On R2 (DRIVE_DISK=r2), turn on bucket versioning for the uploads instead;
# they are not in this tarball.
set -eu

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
AT="${BACKUP_AT:-02:30}"

once() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  dump="/backups/db-$stamp.dump"

  pg_dump --format=custom --no-owner --file="$dump.partial"
  mv "$dump.partial" "$dump"
  echo "backup: wrote $dump ($(du -h "$dump" | cut -f1))"

  files="$dump"

  if [ "${DRIVE_DISK:-fs}" = "fs" ] && [ -d /uploads ]; then
    tarball="/backups/uploads-$stamp.tar.gz"
    tar -czf "$tarball" -C /uploads .
    echo "backup: wrote $tarball"
    files="$files $tarball"
  fi

  if [ -n "${BACKUP_REMOTE:-}" ]; then
    for file in $files; do
      rclone copy "$file" "$BACKUP_REMOTE" && echo "backup: copied $(basename "$file") to $BACKUP_REMOTE"
    done
  else
    echo "backup: BACKUP_REMOTE is not set — these backups exist only on this machine" >&2
  fi

  find /backups -name 'db-*.dump' -mtime +"$KEEP_DAYS" -delete
  find /backups -name 'uploads-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
}

if [ "${1:-}" != "--loop" ]; then
  once
  exit 0
fi

echo "backup: daily at $AT UTC, keeping $KEEP_DAYS days"
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) $AT" +%s 2>/dev/null || date -u -D '%Y-%m-%d %H:%M' -d "$(date -u +%Y-%m-%d) $AT" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  once || echo "backup: FAILED" >&2
done
