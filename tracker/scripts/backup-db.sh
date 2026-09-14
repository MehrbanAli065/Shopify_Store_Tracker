#!/bin/bash
# Nightly dump of the tracker database. Seven kept, oldest dropped.
#
# Runs at 06:30 UTC, AFTER the VM has delivered and ingested the day (it
# finishes around 03:20). It used to run at 02:30, which meant every backup
# was a day behind - the newest one never held the newest day.
#
# Plain SQL, gzipped: it restores with psql alone, which matters when the thing
# you are restoring onto is a machine you have just rebuilt. ~300 MB each.
#
# The password comes from ~/.pgpass (chmod 600), not from this file, so the
# script can be read by anyone who can see the process list without giving
# anything away.
set -u
DIR="$HOME/backups"
KEEP=7
DB=shopify_tracker_db
mkdir -p "$DIR"

OUT="$DIR/tracker-$(date +%F).sql.gz"
if ! pg_dump -h localhost -U tracker -d "$DB" \
       --no-owner --no-privileges --format=plain --compress=gzip:6 -f "$OUT.part"; then
  echo "$(date -Is)  DUMP FAILED" >> "$DIR/backup.log"
  rm -f "$OUT.part"
  exit 1
fi

# Only claim the real name once the dump finished, so a half-written file is
# never mistaken for a good backup.
mv "$OUT.part" "$OUT"
# Say what is actually in it. "A backup exists" and "the backup has today
# in it" are different claims, and only the second one is worth anything.
DAY=$(TZ=Asia/Karachi date '+%Y-%m-%d')
N=$(psql -h localhost -U tracker -d "$DB" -X -q -A -t -c "SELECT count(*) FROM scrape_runs WHERE run_date='$DAY' AND status IN ('success','partial')" 2>/dev/null | tr -d '[:space:]')
echo "$(date -Is)  ok  $(du -h "$OUT" | cut -f1)  $OUT  (holds ${N:-?} stores for $DAY)" >> "$DIR/backup.log"

ls -1t "$DIR"/tracker-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "$(date -Is)  purana hataya: $old" >> "$DIR/backup.log"
done
