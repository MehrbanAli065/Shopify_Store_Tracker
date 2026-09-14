#!/bin/sh
# Clear a day out of ~/csv once the database can account for it.
#
# The old job deleted anything older than three days and never asked whether
# the data had actually landed. That is the wrong test twice over: a day that
# ingested cleanly sat around for three days taking 2.6 GB, and a day that
# never ingested at all was deleted anyway, taking the only raw copy with it.
#
# So the test is the database. A folder goes when the database holds at least
# as many stores for that date as there are CSV files in it. A folder that does
# not pass stays, and the log says why.
#
# There is still a hard backstop below, because a day that never ingests would
# otherwise sit there forever and the disk is shared with 2.6 GB arriving daily.
#
# crontab:  0 7 * * *  /home/mehrban/cleanup-csv.sh
#           07:00 UTC - after the VM delivers (~03:20) and after the 06:30
#           backup, so a day is only dropped once it is in the database AND in
#           a dump.

set -u

ROOT=/home/mehrban/csv
LOG=/home/mehrban/csv-cleanup.log
DB=shopify_tracker_db
KEEP_DAYS=0      # days to hold onto AFTER the database has the day. 0 = drop it
                 # as soon as it is safe. Raise it if you ever want to re-ingest
                 # from the raw files rather than rewind from the database.
BACKSTOP_DAYS=7  # delete regardless of the database after this many days, so a
                 # permanently stuck day cannot fill the disk. Logged loudly.

say() { echo "$(date -Is)  $*" >> "$LOG"; }

[ -d "$ROOT" ] || exit 0

TODAY_EPOCH=$(date -u +%s)
acted=0

for d in "$ROOT"/*/; do
  [ -d "$d" ] || continue
  day=$(basename "$d")

  # Only ever a YYYY-MM-DD folder directly under ~/csv. Anything else is left
  # alone - this script deletes 2.6 GB at a time and should be boring.
  case "$day" in
    20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]) ;;
    *) continue ;;
  esac

  n=$(ls -1 "$d"*.csv 2>/dev/null | wc -l)

  day_epoch=$(date -u -d "$day" +%s 2>/dev/null || echo 0)
  age_days=0
  [ "$day_epoch" -gt 0 ] && age_days=$(( (TODAY_EPOCH - day_epoch) / 86400 ))

  # An empty folder is an aborted upload, not a day. Once it is not today's, it
  # is just clutter.
  if [ "$n" -eq 0 ]; then
    if [ "$age_days" -ge 1 ]; then
      rm -rf -- "$d" && say "removed $day (empty, $age_days days old)" && acted=1
    fi
    continue
  fi

  done_db=$(psql -h localhost -U tracker -d "$DB" -X -q -A -t \
    -c "SELECT count(*) FROM scrape_runs WHERE run_date='$day' AND status IN ('success','partial')" \
    2>/dev/null | tr -d '[:space:]')

  # An unreachable database is not permission to delete anything.
  case "${done_db:-}" in
    ''|*[!0-9]*)
      say "KEPT $day - could not read the database"
      acted=1
      continue ;;
  esac

  if [ "$done_db" -ge "$n" ] && [ "$age_days" -ge "$KEEP_DAYS" ]; then
    size=$(du -sh "$d" | awk '{print $1}')
    rm -rf -- "$d"
    if [ -d "$d" ]; then
      say "FAILED to remove $day"
    else
      say "removed $day - $n files, $size, database has $done_db stores"
    fi
    acted=1
  elif [ "$age_days" -ge "$BACKSTOP_DAYS" ]; then
    size=$(du -sh "$d" | awk '{print $1}')
    rm -rf -- "$d"
    say "BACKSTOP removed $day after $age_days days - the database only ever had $done_db of $n stores. THIS DAY IS INCOMPLETE."
    acted=1
  else
    say "kept $day - $n files on disk, database has $done_db stores"
    acted=1
  fi
done

[ "$acted" -eq 1 ] || exit 0
exit 0
