# Shopify Multi-Store Price & Stock Tracker

Daily CSV in → variant-level change history out → one report per store.

## Quick start

```bash
npm install
npm run reset                 # build the database + seed the store registry
npm start                     # http://localhost:3000
```

## Ingesting a day

```bash
node scripts/ingest.mjs --store 1 --date 2026-07-27 --file "C:\path\alkaram.csv"
node scripts/ingest.mjs --store 1 --date 2026-07-28 --file "C:\path\alkaram.csv"
node scripts/ingest.mjs --store 2 --date 2026-07-28 --file "C:\path\brooklinen.csv"
```

Re-running the **most recent** date for a store is safe: the run is rewound (its
history rows dropped and the current-state layer rebuilt from what remains) and
then redone. Replaying an *older* date is refused, because the current-state
layer holds the newest values and diffing against it would produce nonsense.

## Nightly automation

The daily CSVs live in a **Google Drive folder**, and that folder is the source.
Ingest reads it directly — see **[DRIVE.md](DRIVE.md)** for the one-time
credential setup.

```bash
npm run ingest:drive -- --dry-run     # see the plan, change nothing
npm run ingest:drive -- --archive     # ingest, then move files to Drive/Ingested/
```

Ingest does not run on Vercel — it downloads multi-megabyte CSVs and takes
minutes, while Vercel functions cap at 30–60s. It belongs on a machine you
control: your own, or the UiPath VM.

To run it on a schedule, use `scripts/nightly.bat` with Windows Task Scheduler,
or **[N8N.md](N8N.md)** to drive it from n8n and get told when a night fails.
Note that n8n schedules the ingest — it does not replace it; N8N.md explains why
a Drive → Postgres node chain cannot.

There is also a local-folder variant, for when the files are already on disk:

```bash
node scripts/ingest-folder.mjs --dir "C:\...\Scrapped_Csv_Files" --archive "C:\...\Ingested"
```

Both match each file to a store by `csv_prefix` (longest match wins), work out
the date, and run each store as its own child process behind a small worker
pool, so one bad file cannot take the batch down.

| Flag | Effect |
|---|---|
| `--date YYYY-MM-DD` | force one date for every file |
| `--concurrency N` | stores at once, default 3 |
| `--archive` | Drive: move into an `Ingested` subfolder · local: `--archive <path>` |
| `--trash` | Drive only — send to the Drive trash |
| `--delete` | local only — delete the file |
| `--dry-run` | print the plan, change nothing |
| `--force` | re-ingest dates already recorded |
| `--folder <id\|url>` | Drive only — override `DRIVE_FOLDER_ID` |
| `--dir <path>` | local only — folder to scan |

Safeguards worth knowing:

- **Already-ingested store+date pairs are skipped**, so re-running the job is harmless.
- **Unmatched files are reported, never guessed.** A file whose prefix matches no
  store is listed and left alone.
- **Only successful files are archived or deleted.** Failures stay in the folder
  so the next run retries them.
- The date comes from the filename (`28_07_26`, `2026-07-28`, `28-07-2026`) and
  falls back to the file's modification time. **Keep the date in the filename** —
  the fallback is only correct if the job runs the same day.

### Scheduling it

`scripts/nightly.bat` runs the Drive job under Windows Task Scheduler — set
`APPDIR` at the top, then create a daily task pointing at it. It writes a
per-day log under `logs/` and exits non-zero if any store failed, so a broken
night shows up in the task history instead of passing silently.

## Store registry

IDs are assigned manually in `db/seed.sql` and never change.

| ID | Store | Domain | Currency |
|----|-------|--------|----------|
| 1 | Alkaram Studio | www.alkaramstudio.com | PKR |
| 2 | Brooklinen | www.brooklinen.com | USD |

Add stores 3–100 to the same file and re-run `npm run init`.

## How versioning works

Two layers, and they never overwrite each other:

- **`variants`** — Layer 1. `current_price`, `current_in_stock`, `last_seen_at`.
  Overwritten every day. A cache, rebuildable from history at any time.
- **`variant_history`** — Layer 2. Append-only. One row per *actual* change,
  carrying both the new and the previous values.

A row is written only when `price`, `compare_at_price` or `in_stock` differs.
Each row means *"this value held from this date until the next row"*, so any past
date is recovered with the last row on or before it:

```sql
SELECT * FROM store_state_on(1, '2026-07-27');
```

Measured on the real data: day 2 of Alkaram wrote **136 rows for 7,558 variants (1.8%)**.
A full daily snapshot would have written all 7,558.

### Change types

`new` · `price_up` · `price_down` · `discount_change` · `stock_out` · `stock_in` · `removed`

### Stock detection

`Inventory quantity` never carries a count, but it does carry the state:

| CSV value | Meaning |
|---|---|
| blank | the variant is sellable |
| `0` | the variant has sold out |

Checked against the store's own live `/products.json` feed, which exposes an
`available` boolean per variant publicly. Over 3,406 variants matched on
handle + SKU: blank agreed with `available=true` **99.8%** of the time, and `0`
agreed with `available=false` **96.5%** — **99.2% overall**. The gap is explained
by the day between the CSV and the live fetch.

So:

- blank, or a positive number → **in stock**
- explicit `0` → **out of stock** (`stock_out` when it flips)
- variant gone from the CSV entirely → `stock_out`, or `removed` if its whole
  handle went with it

Exact counts are not obtainable. Shopify gives `inventory_quantity` only to the
store owner via the Admin API, so for a competitor's store "3 left" cannot be had
by any route. In stock / out of stock is the ceiling.

### Safety rule

If today's product count drops below 50% of the previous run, removal detection is
skipped and the run is marked `partial`. One bad download must never mark 2,000
products as removed.

## API

| Route | Returns |
|---|---|
| `GET /api/stores` | all store cards |
| `GET /api/stores/:id` | store meta + available date range + run log |
| `GET /api/stores/:id/summary?from&to` | KPI tiles + daily activity |
| `GET /api/stores/:id/distribution` | discount bands, product types, price range (chart data) |
| `GET /api/stores/:id/report?from&to&type` | the change log (`type` = price / new / stock / removed) |
| `GET /api/stores/:id/report.csv?from&to&type` | same rows as a CSV download |
| `GET /api/stores/:id/timeline?handle=` | one product's full history |
| `GET /api/stores/:id/state?date=` | the whole store as it stood on that date |

## Using the app

**Stores page** — overview strip, then a searchable card grid.

- **Search** by store name, website or ID. Press `/` to jump to the box, `Esc` to clear.
- **Filters**: All · Updated today · Has changes · Needs attention
- **Sort** by ID, name, product count or change count
- Matching text is highlighted; a clear empty state appears when nothing matches

**Store report** — click any card.

- Period presets (Full range / 7 / 30 days) plus a custom date range
- Seven KPI tiles, each with a hover explanation
- Three charts: discount spread, what changed, top product categories — all with hover tooltips
- Day-by-day table
- Change log with its own search box (product name, handle, SKU or variant) and type tabs
- **Click any row** to open a side drawer with that product's full timeline, grouped per variant
- CSV download, and PDF via the browser's print dialog

## The archive — you can delete the CSVs

Once a file has been ingested it can be removed from Drive. The **History** tab rebuilds
any past day's catalogue from `variant_history` using the carry-forward rule, so the
database *is* the archive.

Verified against the real files:

| Date | Original CSV | Rebuilt from DB |
|---|---|---|
| 27 Jul | 1,997 products · 7,588 variants | 1,997 · 7,588 ✓ |
| 28 Jul | 1,975 products · 7,558 variants | 1,975 · 7,558 ✓ |

Each archived day shows the source file name, scrape status and row counts, is
searchable, and can be re-downloaded as a CSV.

| Route | Returns |
|---|---|
| `GET /api/stores/:id/snapshots` | every archived day + its scrape run |
| `GET /api/stores/:id/snapshot?date=&q=&offset=&limit=` | that day's catalogue, searchable and paged |
| `GET /api/stores/:id/snapshot.csv?date=` | that day rebuilt as a CSV download |

> A variant belongs to a day's snapshot when its last recorded state on or before that
> date has `in_stock = true` — i.e. it was still in the feed. That is why the rebuilt
> counts match the original files exactly.

## Layout

```
db/schema.sql            tables, constraints, base indexes
db/*.sql                 derived tables and the indexes added since
db/migrations/           one-time steps, kept as a record — not run on a build
lib/schema-files.mjs     the order those files must run in. The single list
lib/db.mjs               connection — PostgreSQL, or PGlite when unconfigured
lib/audit.mjs            the report engine: every number comes from SQL
scripts/migrate.mjs      build the schema against DATABASE_URL
scripts/ingest.mjs       parse CSV → diff → write history
app.mjs                  the Express app: API + static pages
public/                  store cards, history, per-store page
vercel-site/             built by scripts/build-vercel-site.mjs; do not edit
```

## Notes on production

This runs on **PostgreSQL 16** on the company server; see [DEPLOY.md](DEPLOY.md).
With `DATABASE_URL` unset it falls back to PGlite — Postgres compiled to WASM, in
a file under `data/` — which is only a way to try it with nothing installed.

Two things worth switching on as the history grows:

1. `variant_history` should be `PARTITION BY RANGE (observed_date)` with one
   partition per month. It is kept flat here so one schema file runs both places.
2. `REVOKE UPDATE, DELETE ON variant_history` so history can never be rewritten.
