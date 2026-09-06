# Putting a day's data into the database

Two commands. Both write to the **server's** database — the one the live site
reads — and both are safe to run again at any time.

Everything here is run from the `tracker/` folder.

---

## What you need first

| | |
|---|---|
| **Node 20+** | `node -v` |
| **The ssh key** | `~/.ssh/tracker_deploy` — without it neither command can reach the server |
| **The CSV folders** | `E:\Project CSV\YYYY-MM-DD\` — one folder per day, only for command 1 |

Check the key works:

```bash
ssh -i ~/.ssh/tracker_deploy mehrban@66.45.238.72 "echo ok"
```

If that prints `ok`, both commands will work.

---

## The one rule that matters

**The folder's name is the date. Never the file's timestamp.**

The scrape writes each CSV the *evening before* it is filed, so a folder named
`2026-09-04` is full of files stamped `2026-09-03`:

```
E:\Project CSV\2026-09-04\        ← this is 4 September's data
    https___alkaramstudio_com_shopify.csv   modified 03/09/2026 19:31
```

Both commands take the folder's name and ignore the timestamps. This is not a
detail — trusting the timestamp files a whole day under the day before, and
because that day is usually already ingested, every store reports "already
done" and **nothing is written and nothing looks wrong**.

---

## Command 1 — from a folder on this machine

```bash
npm run ingest:server
```

That is the everyday form: it takes **today's** folder automatically.

### Examples

```bash
# today
npm run ingest:server

# a particular day
npm run ingest:server -- --date 2026-09-05

# a folder somewhere else
npm run ingest:server -- --dir "D:/backup/2026-09-05"

# show the plan, write nothing
npm run ingest:server -- --dry-run
```

### What it prints

```
  folder ka naam hi tareekh hai: --date 2026-09-06

  240 CSV · 2535 MB  →  mehrban@66.45.238.72

· bhej raha hoon — gzip ke sath, warna is link par 55 minute lagte hain …
· server par ingest chal rahi hai …

  240 CSV file(s) found
  46 to ingest · 194 already done · 0 unmatched

  ✓  21 Clothesmentor        2026-09-06  4643 changes
  ✓   8 Selfieleslie         2026-09-06  5873 changes
  ...
  46 succeeded · 0 failed · 105s

  ho gaya — data server ki database mein hai
```

Read it like this:

- **`46 to ingest · 194 already done`** — it skips what is in the database
  already, so running it twice costs nothing
- **`0 unmatched`** — every CSV was matched to a store in the registry. A
  number here means a filename nobody recognises; check `csv_prefix` in the
  `stores` table
- **`46 succeeded · 0 failed`** — the count that matters

### If the folder is not there

```
  folder nahi mila: E:\Project CSV\2026-09-06
  (CSV_BASE = E:/Project CSV — doosri jagah hai to --dir do, ya CSV_BASE set karo)
  mojood folders: 2026-09-03, 2026-09-04, 2026-09-05
```

Usually it simply has not been written yet. Wait, or name the day you want.

---

## Command 2 — from Google Drive, run on the server

```bash
npm run ingest:drive:server
```

This runs the same job the nightly cron runs, without sending anything from
this machine — the server reads Drive itself.

### Examples

```bash
# run it and watch
npm run ingest:drive:server

# start it and walk away  ← use this one for a full day
npm run ingest:drive:server -- --detach

# is it running? what did the last few days come to?
npm run ingest:drive:server -- --status

# show the plan, write nothing
npm run ingest:drive:server -- --dry-run
```

### What `--status` prints

```
  mehrban@66.45.238.72

  ○ nothing running

  the last few days:
119 of 242 stores ingested for 2026-09-06. 123 missing, 1 partial, 0 failed.
226 of 242 stores ingested for 2026-09-06. 16 missing, 2 partial, 0 failed.
237 of 242 stores ingested for 2026-09-06. 5 missing, 2 partial, 0 failed.
240 of 242 stores ingested for 2026-09-06. 2 missing, 4 partial, 0 failed.
```

Four lines for one day is normal — see the next section.

### Why `--detach`

Google rate-limits Drive downloads. The code waits and retries (3s, 10s, 30s,
90s), which works, but a single day has taken **five hours** to download and
still arrived incomplete. Attached, that is five hours of holding an ssh
session open and losing the run when the laptop sleeps. Detached, the server
carries on alone and `--status` tells you where it got to.

---

## Which command to use

| | Command 1 (local) | Command 2 (Drive) |
|---|---|---|
| Sends | 2.5 GB over your connection | nothing |
| Takes | a few minutes | minutes to hours |
| Can be throttled | no | **yes, often** |
| Needs | the folder on this machine | nothing local |

**Use command 1 when the folder is on the machine.** It is slower to send but
nothing can stop it half way.

**Use command 2 when it is not** — and expect to run it more than once.

---

## The nightly run

It already happens by itself:

```
0 6 * * *  /home/mehrban/tracker/scripts/ingest-daily.sh
```

**06:00 UTC = 11:00 Asia/Karachi.** The server runs on UTC, so the crontab hour
is five less than Pakistani time.

When it finishes it emails two lines to `techbugs86@gmail.com`, taken from the
**database** rather than from its own output — so a run that dies half way
still reports honestly. The full log is on the server at `~/ingest.log`.

You only need the commands above when that run comes back short.

---

## When a day comes back incomplete

This is the normal shape of a bad day, and it is not a code failure:

```
119 of 242 stores ingested for 2026-09-06. 123 missing, 1 partial, 0 failed.
  ✗ 126 12storeez            2026-09-06  DOWNLOAD FAILED
  ✗  37 1822denim            2026-09-06  DOWNLOAD FAILED
```

`DOWNLOAD FAILED` means Google would not hand the file over — its rate limit,
not a permissions problem. What to do:

1. **Run command 2 again.** Each run gets further, because the throttle eases
   with time. A real day went `119 → 226 → 237 → 240` across four runs.
2. **Or use command 1** if the folder is on this machine — no throttle applies.
3. Repeat until `missing` is only the stores whose file is not in Drive at all.

`0 failed` alongside `N missing` means nothing broke — those stores simply had
no file that day.

---

## Checking what actually landed

```bash
ssh -i ~/.ssh/tracker_deploy mehrban@66.45.238.72 \
  "cd ~/tracker && node -e \"
    import('dotenv/config').then(async () => {
      const { q } = await import('./lib/db.mjs')
      console.table(await q(\\\`SELECT run_date, count(*)::int stores,
        count(*) FILTER (WHERE status='success')::int ok,
        count(*) FILTER (WHERE status='partial')::int partial
        FROM scrape_runs WHERE run_date >= current_date - 4
        GROUP BY 1 ORDER BY 1\\\`))
      process.exit(0)
    })\""
```

Or just read the tail of the log:

```bash
ssh -i ~/.ssh/tracker_deploy mehrban@66.45.238.72 "tail -20 ~/ingest.log"
```

---

## Things that will bite you

**Re-running is safe. Skipping is not.** Both commands skip a store+date that
is already recorded, so run them as often as you like. What you must not do is
assume a day is in because a command exited quietly — check the count.

**"already done" for a whole folder means the date was read wrong.** If a
command reports `240 already done` on a day you know is missing, it has
resolved the wrong date. Pass `--date` explicitly.

**Only the most recent date can be re-ingested.** Replaying an older day is
refused on purpose: the current-state layer holds the newest values, and
diffing an old file against it produces nonsense.

**Two stores having no file is normal.** The registry has 242 active stores;
Drive usually holds 239–240 CSVs. The rest simply were not exported that day.
