# Running the ingest on the scraper VM

The CSVs land on the UiPath VM **before** they are uploaded to Drive. Ingesting
them there needs no Google credentials at all — the files are already on disk.

```
UiPath scrapes  ─→  C:\...\Scrapped_Csv_Files\   ─→  ingest  ─→  Neon (cloud)
                            │
                            └─────────────────────→  Drive (backup copy)
```

The database is in the cloud, so it is reachable from the VM exactly as it is
from anywhere else. Only the **ingest** moves; the web app stays on Vercel.

---

## One-time setup, about ten minutes

### 1 · Install Node on the VM

<https://nodejs.org> → **LTS** → next-next-finish. Then in a new terminal:

```bash
node --version      # v20 or newer
```

### 2 · Get the code onto the VM

With git:

```bash
cd C:\
git clone https://github.com/techbugs86/Shopify_Stores_Scraper.git shopify-tracker
```

Without git: download the repo as a ZIP from GitHub and unzip to `C:\shopify-tracker`.

### 3 · Install dependencies

```bash
cd C:\shopify-tracker\tracker
npm install --omit=dev
```

`--omit=dev` skips PGlite, which is only for local development. The VM talks to
the cloud database, so it is not needed.

### 4 · Point it at the database

Create `C:\shopify-tracker\tracker\.env` with the **same** connection string this
machine uses — Vercel → Storage → your database → `.env.local` tab:

```
DATABASE_URL=postgresql://neondb_owner:PASSWORD@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
PG_MAX=3
```

No `DRIVE_FOLDER_ID`, no Google keys — this route does not touch Drive.

> ### ⚠ Never run `npm run migrate` on the VM
>
> `migrate` starts with `DROP TABLE … CASCADE`. It builds a database from
> nothing, and it would **wipe every day of history you have**. The tables
> already exist; the VM only ever needs to ingest.
>
> Safe to run there: `ingest-folder`, `ingest`, `migrate:check`, `seed`.
> Never: `migrate`, `reset`, `init`.

### 5 · Check the connection

```bash
npm run migrate:check
```

Expected — note it reports the existing tables rather than "empty":

```
  target: PostgreSQL · ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb  [postgres]
  existing tables: products, scrape_runs, stores, variant_history, variants
  rows: {"products":2481,"variants":13499,...}
```

### 6 · Dry-run against the real drop folder

```bash
node scripts/ingest-folder.mjs --dir "C:\Users\Administrator\Documents\UiPath\Shopify_Scraper\Scrapped_Csv_Files" --dry-run
```

It lists what it would ingest, which store each file matched, and the date it
derived — and changes nothing. Read that output before going further.

### 7 · Run it for real

```bash
node scripts/ingest-folder.mjs --dir "C:\...\Scrapped_Csv_Files" --archive "C:\...\Ingested"
```

Successful files move to `Ingested\` with the date prefixed. Failures stay put so
the next run retries them.

---

## Schedule it

`scripts/nightly-local.bat` wraps the command. Edit the three paths at the top,
then:

1. **Task Scheduler** → **Create Task**
2. **General** → tick *Run whether user is logged on or not* and *Run with highest privileges*
3. **Triggers** → New → **Daily**, a couple of hours after the scrape finishes
4. **Actions** → New → *Start a program* → browse to `nightly-local.bat`
5. **Settings** → tick *Run task as soon as possible after a scheduled start is missed*

It writes `logs\ingest-YYYY-MM-DD.log` and exits non-zero if any store failed,
so a broken night shows up in the task history instead of passing silently.

---

## Ordering

Ingest must run **after** the scrape. Two ways:

- **Simplest:** schedule ingest a couple of hours later. If the scrape is late,
  nothing breaks — nothing gets ingested that night, and the next run picks the
  files up because they are still in the folder.
- **Tighter:** have the UiPath workflow call `nightly-local.bat` as its last step,
  so ingest starts the moment the scrape finishes.

Either is fine. The job is safe to run repeatedly: finished store + date pairs are
skipped, so an extra run does nothing.

---

## Keep the date in the filename

The scraper currently writes:

```
https___www_alkaramstudio_com__shopify.csv       ← no date
```

Ingest falls back to the file's modification time, which is only correct when it
runs the same day. If a night is missed, a dateless file gets recorded against
the wrong day. Ask for this instead:

```
https___www_alkaramstudio_com__shopify_29_07_26.csv
```

`28_07_26`, `2026-07-28` and `28-07-2026` are all understood.

---

## Adding stores 3–100

Files are matched to stores by `csv_prefix` — the start of the filename. When a
new store's CSV appears, ingest reports it as unmatched and leaves it alone
rather than guessing.

To register it, add a line to `db/seed.sql` and run:

```bash
npm run seed
```

That applies `seed.sql` alone. It upserts, so it never touches products,
variants, history or runs — verified against the live database: 2,481 products
and 13,626 history rows before and after.

**Do not use `npm run migrate` for this.** It starts with `DROP TABLE … CASCADE`
and would take every day of history with it.

The VM needs no change — it re-reads the store list on every run.

---

## Deciding between this and the Drive route

| | VM local folder | Drive |
|---|---|---|
| Google credentials | none | API key or service account |
| Extra download step | no | yes |
| Breaks if Drive quota fills | no | yes |
| Works if the VM is unreachable | no | yes |
| Setup | Node + repo on the VM | credentials only |

This route is simpler and has fewer moving parts. Drive stays useful as the
backup copy and the handoff to anyone who wants the raw files.
