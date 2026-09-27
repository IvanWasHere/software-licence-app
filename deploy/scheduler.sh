#!/bin/sh
# Dispatches the scheduled jobs (docs/deployment.md, "Backups and retention")
# the way cron would, at the top of each minute:
#
#   every 5 minutes   node ace schedule:run --interval=5m
#   every hour, :00   node ace schedule:run --interval=hourly   (abuse flags)
#   daily at 03:00    node ace schedule:run --interval=daily    (expiry reminders,
#                                                               billing sync, pruning)
#
# All times UTC. It only queues; the worker does the work, so a slow job never
# overlaps its own next run.
set -u

run() {
  node ace schedule:run --interval="$1" || echo "schedule:run --interval=$1 failed" >&2
}

while true; do
  # Sleep to the start of the next minute.
  sleep $((60 - $(date -u +%S | sed 's/^0//')))

  minute=$(date -u +%M | sed 's/^0//')
  hour=$(date -u +%H | sed 's/^0//')

  [ $((minute % 5)) -eq 0 ] && run 5m
  [ "$minute" -eq 0 ] && run hourly
  [ "$minute" -eq 0 ] && [ "$hour" -eq 3 ] && run daily
done
