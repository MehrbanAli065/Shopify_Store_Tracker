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

Re-running the same store + date is safe — the run is replaced.

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

Both sample stores ship `Inventory quantity` as **all zeros**, so stock is derived
from feed presence instead:

- variant present in today's CSV → in stock
- present yesterday, missing today → `stock_out` (or `removed` if the whole handle went)

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
db/schema.sql       5 tables, indexes, v_change_report view, store_state_on()
db/seed.sql         the store registry
lib/db.mjs          PGlite connection
scripts/init-db.mjs build / reset the database
scripts/ingest.mjs  parse CSV → diff → write history
server.mjs          API + static frontend
public/             store cards + report page
data/pgdata/        the database itself (git-ignore this)
```

## Notes on production

This runs on **PGlite** — PostgreSQL compiled to WASM — so there is nothing to
install locally. The SQL is plain Postgres and moves to Supabase or any Postgres
server unchanged. Two things to switch on there:

1. `variant_history` should be `PARTITION BY RANGE (observed_date)` with one
   partition per month. It is kept flat here so one schema file runs both places.
2. `REVOKE UPDATE, DELETE ON variant_history` so history can never be rewritten.
