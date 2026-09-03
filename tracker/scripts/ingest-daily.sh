#!/bin/sh
# The nightly job, with a two-line email when it is done.
#
#   crontab:  0 7 * * *  /home/mehrban/tracker/scripts/ingest-daily.sh
#
# Runs ingest-drive.mjs, then asks the database what actually landed and mails
# that. The numbers come from the database rather than from the script's own
# output on purpose: if the run dies halfway, parsing its log would report
# whatever it had printed before dying, while the database still knows the
# truth.
#
# MAIL_TO is read from tracker/.env. No address, no mail — the ingest still
# runs, so a missing address can never stop the data going in.
#
# Mail goes out through the box's Postfix via sendmail. Nothing to configure,
# but the first one may land in spam: this IP has no SPF or DKIM of its own.

set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DIR" || exit 1

LOG="$HOME/ingest.log"
NODE=/usr/bin/node

# .env carries DATABASE_URL and, optionally, MAIL_TO.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

STARTED=$(date -u '+%Y-%m-%d %H:%M:%S UTC')

echo "" >> "$LOG"
echo "===== $STARTED =====" >> "$LOG"
"$NODE" scripts/ingest-drive.mjs >> "$LOG" 2>&1
RC=$?

# ── what the database says, which is the only account that matters ──
# The run date is the folder the script chose, so it is read back from the log
# rather than guessed from today's clock — a run just after midnight, or one
# that fell back to the newest folder, would otherwise be reported as a day
# with nothing in it.
DAY=$(sed -n 's/^  day *\([0-9-]\{10\}\).*/\1/p' "$LOG" | tail -1)
[ -n "$DAY" ] || DAY=$(TZ=${DRIVE_TZ:-Asia/Karachi} date '+%Y-%m-%d')

read_db() {
  psql "$DATABASE_URL" -X -q -A -t -c "$1" 2>/dev/null | tr -d '[:space:]'
}

ACTIVE=$(read_db "SELECT count(*) FROM stores WHERE active")
DONE=$(read_db "SELECT count(*) FROM scrape_runs WHERE run_date='$DAY'")
FAILED=$(read_db "SELECT count(*) FROM scrape_runs WHERE run_date='$DAY' AND status NOT IN ('success','partial')")
PARTIAL=$(read_db "SELECT count(*) FROM scrape_runs WHERE run_date='$DAY' AND status='partial'")
CHANGES=$(read_db "SELECT COALESCE(sum(changes_found),0) FROM scrape_runs WHERE run_date='$DAY'")

: "${ACTIVE:=?}" "${DONE:=?}" "${FAILED:=0}" "${PARTIAL:=0}" "${CHANGES:=0}"

MISSING=$(( ACTIVE - DONE )) 2>/dev/null || MISSING='?'

if [ "$RC" -eq 0 ] && [ "$MISSING" -le 2 ] 2>/dev/null; then
  VERDICT="OK"
else
  VERDICT="CHECK"
fi

SUBJECT="[$VERDICT] Shopify tracker $DAY - $DONE/$ACTIVE stores"
LINE1="$DONE of $ACTIVE stores ingested for $DAY. $MISSING missing, $PARTIAL partial, $FAILED failed."
LINE2="$CHANGES changes recorded. Exit $RC. Full log on the server: $LOG"

echo "$LINE1" >> "$LOG"
echo "$LINE2" >> "$LOG"

if [ -n "${MAIL_TO:-}" ]; then
  HOST=$(hostname -f 2>/dev/null || hostname)
  # Message-ID and Date are not optional. Gmail refuses a message without a
  # Message-ID outright — 550 5.7.1 "Messages missing a valid Message-ID header
  # are not accepted" — and the bounce is addressed to tracker@$HOST, which
  # does not exist locally, so it is discarded. The result is a mail that
  # sendmail accepted, that left an empty queue, and that simply never arrived
  # with nothing anywhere to say why. Postfix only fills these in when
  # always_add_missing_headers is on, and it is off by default.
  MID="<$(date +%s).$$.tracker@$HOST>"
  {
    echo "To: $MAIL_TO"
    echo "From: Shopify Tracker <tracker@$HOST>"
    echo "Subject: $SUBJECT"
    echo "Message-ID: $MID"
    echo "Date: $(date -R)"
    echo "MIME-Version: 1.0"
    echo "Content-Type: text/plain; charset=utf-8"
    echo ""
    echo "$LINE1"
    echo "$LINE2"
  } | /usr/sbin/sendmail -t && echo "  mail sent to $MAIL_TO  $MID" >> "$LOG" \
                            || echo "  mail FAILED to send" >> "$LOG"
else
  echo "  MAIL_TO not set in tracker/.env - no mail sent" >> "$LOG"
fi

exit "$RC"
