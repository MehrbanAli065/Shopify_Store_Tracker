# Shopify Stores Scraper & Tracker

Daily price and stock tracking across 242 Shopify stores. A scraper drops one CSV per
store onto Google Drive each day; those files are ingested into PostgreSQL, diffed
against the previous day, and served as a per-store report.

Tracking is at **variant level** — size, colour and fabric — not just product level.

```
Google Sheet (store URLs)
      ↓
UiPath  ─ downloads one CSV per store ─→  Google Drive
      ↓
ingest  ─ parse → diff vs yesterday → write only what changed
      ↓
PostgreSQL
      ↓
Web app  ─ store cards → report → history → CSV / PDF
```

## Repository layout

| Path | What it is |
|---|---|
| [`tracker/`](tracker/) | The application — database, ingest, API and frontend |
| [`UiPath_Side_Scraping/`](UiPath_Side_Scraping/) | The UiPath robots that produce the daily CSVs |

Start with [`tracker/README.md`](tracker/README.md) to run it, and
[`tracker/DEPLOY.md`](tracker/DEPLOY.md) for how the live deployment is put together.

## Quick start

```bash
cd tracker
cp .env.example .env                            # point DATABASE_URL at your Postgres
npm install
npm run migrate                                 # build the schema + store registry
npm start                                       # http://localhost:3000
```

Then ingest a day:

```bash
node scripts/ingest.mjs --store 1 --date 2026-07-27 --file "path/to/store.csv"
```

With `DATABASE_URL` unset the app falls back to **PGlite** — Postgres compiled to WASM,
in a file under `data/` — so it will start with nothing installed. That is a convenience
for trying it out, not how it runs: the real database is PostgreSQL.

## How the history works

Two layers that never overwrite each other:

- **`variants`** holds the current state and is refreshed every day.
- **`variant_history`** is append-only. A row is written *only* when price, compare-at
  price or stock actually changed, and it carries both the new and previous values.

Each history row means *"this value held from this date until the next row"*, so any past
date is reconstructed by taking the last row on or before it. Measured on real data, day 2
of a 7,558-variant store wrote **136 rows — 1.8%** of a full snapshot, while still
answering every question a full snapshot could.

Because of this, **CSVs can be deleted from Drive after ingest**. The History tab rebuilds
any past day from the database, and the reconstructed counts match the original files
exactly.

## Notes

- Scraped CSVs are gitignored. They are data, not code.
- `Inventory quantity` arrives as all zeros in every store checked so far, so stock is
  derived from feed presence instead — see [`tracker/README.md`](tracker/README.md).
- The app itself has **no login**. The deployment relies on Vercel Authentication in
  front of it and a shared token behind it; see [`tracker/DEPLOY.md`](tracker/DEPLOY.md).
