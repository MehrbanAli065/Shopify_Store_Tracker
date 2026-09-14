#!/bin/bash
# Daily check that the server still looks the way it is supposed to.
#
# Written after 14 Sep 2026. It is not an antivirus - it is a list of the
# specific things that were verified by hand that day, so that a change to any
# of them is noticed by a machine instead of by luck.
#
# Quiet when everything matches. Mails, and exits 1, when anything does not.
#
#   crontab:  15 7 * * *  /home/mehrban/security-scan.sh
#
# Every EXPECT_ below is a fact checked on 14 Sep 2026. If you legitimately add
# an ssh key, a cron job, or a database function, update the matching line here
# in the same change - otherwise this mails every morning and gets ignored,
# which is worse than not having it.

set -u

H=/home/mehrban
DB=shopify_tracker_db
DBUSER=tracker
MAIL_TO=techbugs86@gmail.com

EXPECT_SSH_KEYS="bosqsTAPPkSAgzs2phx+UfQpifANqToLojKuTZ9Af7E EEYOJ8unyCIuWMIkPblOn23IBQiqyxw4Lh+OWIcrX2s"
EXPECT_CRON_JOBS=4          # backup, daily check, csv cleanup, this scan
EXPECT_EXTENSIONS="pg_trgm plpgsql"
EXPECT_TABLES=10
EXPECT_FUNCTIONS=5

findings=()
note() { findings+=("$1"); }

# A check that cannot run is not a check that passed. `file` was missing on this
# box and one whole test did nothing for it, silently.
for t in ssh-keygen crontab find grep awk sed tr head wc psql; do
  command -v "$t" >/dev/null 2>&1 || note "the tool '$t' is missing - some checks below cannot run"
done

psq() { psql -h localhost -U "$DBUSER" -d "$DB" -X -q -A -t -c "$1" 2>/dev/null | tr -d '[:space:]'; }

# ── the way back in ────────────────────────────────────────────────
# An added key is the quietest possible backdoor: nothing runs, nothing shows
# in a process list, and the door is open forever.
keys=$(ssh-keygen -lf "$H/.ssh/authorized_keys" 2>/dev/null | awk '{print $2}' | sed 's/^SHA256://')
for k in $keys; do
  case " $EXPECT_SSH_KEYS " in
    *" $k "*) ;;
    *) note "an ssh key is authorised that was not there on 14 Sep: $k" ;;
  esac
done
for k in $EXPECT_SSH_KEYS; do
  echo "$keys" | grep -qF "$k" || note "an expected ssh key is GONE: $k"
done

[ -e "$H/.ssh/rc" ] && note "~/.ssh/rc exists - it runs on every single login"
[ -e "$H/.ssh/config" ] && note "~/.ssh/config exists - check it for ProxyCommand"
for f in "$H/.git-credentials" "$H/.netrc"; do
  [ -e "$f" ] && note "$f exists - a password or token is stored in the clear"
done

# ── the way to run again ───────────────────────────────────────────
n=$(crontab -l 2>/dev/null | grep -cvE '^\s*(#|$)')
[ "$n" -eq "$EXPECT_CRON_JOBS" ] || note "the crontab has $n jobs, expected $EXPECT_CRON_JOBS"
[ -d "$H/.config/systemd/user" ] && note "~/.config/systemd/user exists - a user service can persist there"
[ -d "$H/.config/autostart" ] && note "~/.config/autostart exists"

for f in "$H/.bashrc" "$H/.profile" "$H/.bash_logout"; do
  [ -f "$f" ] || continue
  if grep -qE '(curl|wget)[^|]*\|\s*(ba)?sh|/dev/tcp/|base64 -d\s*\|' "$f"; then
    note "$f contains a fetch-and-run line"
  fi
done

# ── the filesystem ─────────────────────────────────────────────────
PRUNE="-path $H/csv -prune -o -path $H/backups -prune -o"

# shellcheck disable=SC2086
s=$(find "$H" $PRUNE -type f \( -perm -4000 -o -perm -2000 \) -print 2>/dev/null | head -5)
[ -n "$s" ] && note "setuid or setgid files under the home directory: $s"

# shellcheck disable=SC2086
s=$(find "$H" $PRUNE ! -user mehrban -print 2>/dev/null | head -5)
[ -n "$s" ] && note "files owned by someone else: $s"

# shellcheck disable=SC2086
s=$(find "$H" $PRUNE -type f \( -name '*.sh' -o -name '*.mjs' -o -name '*.js' -o -name '*.py' \) \
      -newermt '-2 days' -print 2>/dev/null | grep -v '/node_modules/' | head -10)
if [ -n "$s" ]; then
  for f in $s; do
    # This file carries those patterns as search terms, so it matches itself.
    [ "$f" = "$0" ] && continue
    case "$f" in */security-scan.sh) continue ;; esac
    grep -qE '(curl|wget)[^|]*\|\s*(ba)?sh|eval\(atob|/dev/tcp/' "$f" 2>/dev/null &&
      note "a script changed in the last two days fetches and runs something: $f"
  done
fi

# A font that is text was how the 11 Sep payload hid. Cheap to check, and it is
# the one test the attacker did not think about.
#
# Not `file` - it is not installed on this box, and its absence made this check
# pass silently, which is worse than not having it. This reads the bytes
# directly: a real font has non-printable bytes within its first few, and text
# does not.
is_text() {
  head -c 512 "$1" 2>/dev/null | LC_ALL=C tr -d '[:print:][:space:]' | wc -c
}
# shellcheck disable=SC2086
for f in $(find "$H" $PRUNE -type f \( -name '*.woff2' -o -name '*.woff' -o -name '*.ttf' -o -name '*.eot' -o -name '*.otf' \) -print 2>/dev/null | head -50); do
  [ "$(is_text "$f")" -eq 0 ] && note "a font file that is actually text: $f"
done

# ── the database ───────────────────────────────────────────────────
if ! psq 'SELECT 1' >/dev/null 2>&1; then
  note "could not reach the database to check it"
else
  # A comma, not a space: psq() strips whitespace, which would glue the names
  # into one word and report every extension as unexpected.
  ext=$(psq "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension")
  for e in $(echo "$ext" | tr ',' ' '); do
    case " $EXPECT_EXTENSIONS " in
      *" $e "*) ;;
      *) note "an unexpected PostgreSQL extension is installed: $e" ;;
    esac
  done

  # plperlu and plpythonu run shell commands as the database user. Their
  # presence is the single loudest signal in a compromised Postgres.
  n=$(psq "SELECT count(*) FROM pg_language WHERE NOT lanpltrusted AND lanname NOT IN ('c','internal')")
  [ "${n:-0}" -gt 0 ] && note "an untrusted procedural language is installed - it can run shell commands"

  n=$(psq "SELECT count(*) FROM pg_event_trigger")
  [ "${n:-0}" -gt 0 ] && note "$n event trigger(s) exist - there were none on 14 Sep"

  n=$(psq "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")
  [ "${n:-0}" -eq "$EXPECT_TABLES" ] || note "the database has ${n:-?} tables, expected $EXPECT_TABLES"

  n=$(psq "SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')")
  [ "${n:-0}" -eq "$EXPECT_FUNCTIONS" ] || note "the database has ${n:-?} functions of its own, expected $EXPECT_FUNCTIONS"

  n=$(psq "SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname NOT IN ('pg_catalog','information_schema') AND p.prosrc ~* 'FROM PROGRAM|pg_read_file|pg_write_file|lo_export'")
  [ "${n:-0}" -gt 0 ] && note "a database function reads files or runs programs"

  n=$(psq "SELECT count(*) FROM pg_largeobject_metadata")
  [ "${n:-0}" -gt 0 ] && note "$n large object(s) exist - there were none on 14 Sep, and they can hold a binary"

  n=$(psq "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND tablename ~* 'readme|recover|warning|bitcoin|decrypt|ransom'")
  [ "${n:-0}" -gt 0 ] && note "a table is named like a ransom note"
fi

# ── report ─────────────────────────────────────────────────────────
if [ ${#findings[@]} -eq 0 ]; then
  echo "$(date -Is)  ok  nothing changed" >> "$H/security-scan.log"
  exit 0
fi

{
  echo "The daily security check on $(hostname -f) found ${#findings[@]} thing(s) that changed."
  echo "Each one was verified by hand on 14 Sep 2026 and should still look the same."
  echo
  for f in "${findings[@]}"; do echo "  - $f"; done
  echo
  echo "If one of these is a change you made, update the EXPECT_ values at the top"
  echo "of $H/security-scan.sh so this stops mailing about it."
} | tee -a "$H/security-scan.log" | {
  if [ -n "$MAIL_TO" ]; then
    HOST=$(hostname -f 2>/dev/null || hostname)
    {
      echo "To: $MAIL_TO"
      echo "From: Shopify Tracker <tracker@$HOST>"
      echo "Subject: [CHECK] server security scan - ${#findings[@]} finding(s)"
      echo "Message-ID: <$(date +%s).$$.scan@$HOST>"
      echo "Date: $(date -R)"
      echo "MIME-Version: 1.0"
      echo "Content-Type: text/plain; charset=utf-8"
      echo ""
      cat
    } | /usr/sbin/sendmail -t
  else
    cat
  fi
}
exit 1
