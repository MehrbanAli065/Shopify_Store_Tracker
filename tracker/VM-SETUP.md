# Running the ingest on the scraper VM

The CSVs land on the UiPath VM **before** they are uploaded to Drive. Ingesting
them there needs no Google credentials at all — the files are already on disk.

```
UiPath scrapes  ─→  C:\...\Scrapped_Csv_Files\   ─→  ingest  ─→  PostgreSQL
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

The VM has no git — and `git clone` would not help anyway, because **this repo is
private**, so neither cloning nor GitHub's ZIP link works without signing in.

Copy the ready-made archive across instead. It sits in the project root:

```
shopify-tracker-vm.zip        (52 KB)
```

Rebuild it any time with `npm run pack:vm`. It deliberately excludes
`node_modules`, `data/`, `logs/`, `secure/`, `.env` and every `.csv` — so nothing
secret and nothing large travels with it.

**Transfer it** by dragging the file into the RDP window, or via any shared
folder. Then on the VM:

```powershell
Expand-Archive -Path "$env:USERPROFILE\Downloads\shopify-tracker-vm.zip" -DestinationPath "C:\" -Force
Test-Path C:\shopify-tracker\tracker\scripts\ingest-folder.mjs      # True
```

The layout should end up as:

```
C:\shopify-tracker\tracker\package.json
C:\shopify-tracker\tracker\scripts\ingest-folder.mjs
```

> **Updating later:** re-run `npm run pack:vm`, copy the new zip over and expand
> it with `-Force`. Keep `tracker\.env` — it is not in the archive, so it survives
> an overwrite.
>
> If you would rather use git, install it on the VM and authenticate to GitHub;
> a private repo needs credentials either way.

### 3 · Install dependencies

```bash
cd C:\shopify-tracker\tracker
npm install --omit=dev
```

`--omit=dev` skips PGlite, which is only for local development. The VM talks to
the cloud database, so it is not needed.

### 4 · Point it at the database

Create `C:\shopify-tracker\tracker\.env` with the **same** connection string the
rest of the setup uses:

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
PG_MAX=3
```

> This has to be a database the VM can actually reach. A PostgreSQL running on
> someone's laptop is not one — `localhost` on the VM means the VM.

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
  target: PostgreSQL · your-host/your-db  [postgres]
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

## Wiring it into the existing UiPath workflow

This is the tidiest option, because the workflow already loops over the local
files before uploading them.

After the `For Each File in Folder` loop — still inside `Try` — add one activity:

| Activity | **Start Process** |
|---|---|
| FileName | `C:\shopify-tracker\tracker\scripts\nightly-local.bat` |

That is the whole change. Scrape → upload to Drive → ingest, in one run.

The paths inside `nightly-local.bat` are already set for this project, and it
checks them before doing anything — a wrong path, a missing drop folder or Node
absent from PATH each exit with code 2 and an explicit message, rather than
failing quietly inside a scheduled run.

> The workflow's Drive connection is not involved at all. It uses UiPath's own
> OAuth client, whose token lives inside UiPath's connection store and cannot be
> handed to an external script. That connection stays exactly as it is, for the
> upload; ingest reads the local folder instead.

---

## Or schedule it separately

`scripts/nightly-local.bat` also works as a standalone task:

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
