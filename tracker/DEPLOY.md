# Deploying to Vercel

## Read this first

The app currently runs on **PGlite** — a Postgres that lives in a file under `data/`.
That cannot go to Vercel: serverless functions get a **read-only, throwaway filesystem**,
so the database would be empty on every request.

So deployment is two things, not one:

| Piece | Where it goes |
|---|---|
| Frontend + API | **Vercel** |
| Database | **Hosted Postgres** — any provider, or your own server |
| Ingest (CSV → DB) | **Stays off Vercel.** Run it from your machine or the UiPath VM |

> **A local PostgreSQL cannot serve the deployed site.** Vercel runs in a data
> centre; `localhost` there is Vercel's own container, not your machine. If the
> database is on your laptop, the site can only be used locally with `npm start`.
> This is the one decision deployment actually rests on.

> **Why ingest cannot run on Vercel:** it reads multi-megabyte CSVs from disk and takes
> minutes for 100 stores. Vercel functions cap at 30–60s and have no file access. Ingest
> is a batch job — it belongs next to wherever the CSVs land.

The code is already dual-mode. Set `DATABASE_URL` and it uses hosted Postgres; leave it
unset and it uses the local PGlite file. Nothing else changes.

---

## Step 1 · Create a hosted Postgres

### Easiest: create it inside Vercel

If the project is already on Vercel, you do not need a separate account:

1. Open the project → **Storage** tab → **Create Database** → **Postgres**
2. Pick a region near your users → **Create**
3. Connect it to the project when prompted

Vercel provisions the database and injects the connection string into the project
automatically (`DATABASE_URL` / `POSTGRES_URL` — the app accepts either). **Redeploy**
once so the running build picks the variable up.

To run migrations and ingest from your machine, copy the string from
**Storage → your database → `.env.local` tab** into `tracker/.env`.

### Or bring your own

Any PostgreSQL 14+ works. Nothing in this project uses a provider-specific feature —
the same schema and the same `ingest_store_day()` run on PGlite locally, on a managed
service, and on `apt install postgresql`.

```
postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
```

Two things to get right whoever hosts it:

- **Take the pooled endpoint** if the provider offers one (often marked `-pooler`, or
  "Transaction pooler"). Serverless functions open many short connections and a direct
  endpoint runs out of them.
- **It has to be reachable from Vercel.** Own-server setups need port 5432 open to the
  internet and TLS on, which is why a managed service is usually less work.

> Storage is the thing to size in advance. Measured on real data: about 1 GB of
> `products` + `variants` for 100 stores, plus roughly 2–6 GB of history per year.
> Most free tiers are 0.5 GB.

---

## Step 2 · Point your machine at it and create the tables

In the `tracker/` folder:

```bash
cp .env.example .env
```

Open `.env` and paste your connection string:

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
```

Check the connection:

```bash
npm run migrate:check
```

You should see `target: PostgreSQL · your-host/your-db  [postgres]` and `database is empty`.

Now create the schema and the store registry:

```bash
npm run migrate
```

Expected output:

```
  tables: products, scrape_runs, stores, variant_history, variants
  stores:
    1 · Alkaram Studio   www.alkaramstudio.com  [PKR]
    2 · Brooklinen       www.brooklinen.com  [USD]
✓ migration complete
```

---

## Step 3 · Load the data into the cloud database

With `.env` still pointing at the hosted DB, run the same ingest commands:

```bash
node scripts/ingest.mjs --store 1 --date 2026-07-27 --file "C:\path\alkaram-27jul.csv"
node scripts/ingest.mjs --store 1 --date 2026-07-28 --file "C:\path\alkaram-28jul.csv"
node scripts/ingest.mjs --store 2 --date 2026-07-28 --file "C:\path\brooklinen.csv"
```

This is slower than PGlite because every statement crosses the network — a few minutes
per store is normal.

Verify:

```bash
npm run dev
```

The banner should now read `db PostgreSQL · your-host/your-db  [postgres]`. Open
<http://localhost:3000> — you are looking at the cloud database through the local server.
If the stores and reports appear, deployment will work.

---

## Step 4 · Push to GitHub

`.gitignore` already excludes `node_modules/`, `data/`, `.env` and `.vercel/`.
**Never commit `.env`** — it holds the database password.

```bash
git init
git add .
git commit -m "Shopify store tracker"
git branch -M main
git remote add origin https://github.com/<you>/shopify-tracker.git
git push -u origin main
```

---

## Step 5 · Deploy

1. <https://vercel.com> → **Add New → Project** → import the repo
2. **Root Directory** — set it to `tracker` if the repo root is `Shopify_Stores`
3. **Framework Preset** — `Other`
4. Leave build and output settings empty
5. Open **Environment Variables** and add:

| Name | Value | Environments |
|---|---|---|
| `DATABASE_URL` | your pooled connection string | Production, Preview, Development |
| `PG_MAX` | `3` | all |

6. **Deploy**

`vercel.json` routes every `/api/*` request into `api/index.mjs`, which mounts the same
Express app you run locally. Everything in `public/` is served as static files.

---

## Step 6 · Check it

Open your `*.vercel.app` URL. Then verify the API directly:

```
https://your-app.vercel.app/api/stores
```

You should get the store list as JSON.

---

## Daily routine after deployment

```
UiPath drops CSVs on Drive
        ↓
you (or a scheduled job) run:
        node scripts/ingest.mjs --store N --date YYYY-MM-DD --file <path>
        ↓
Your database provider
        ↓
Vercel site shows it immediately — no redeploy needed
```

Deploying again is only needed when the **code** changes, not the data.

---

## Troubleshooting

**`DATABASE_URL is not set` on the live site**
The variable is missing or was added after the last deploy. Add it under
Project Settings → Environment Variables, then **Redeploy** — Vercel only picks up
env vars at build time.

**`too many connections`**
You are on the direct endpoint. Switch to the pooled one (often marked `-pooler`,
Transaction pooler on Supabase) and keep `PG_MAX=3`.

**`self-signed certificate` / TLS errors**
Make sure the connection string ends with `?sslmode=require`. The code already sets
`rejectUnauthorized: false`, which is what these providers' shared certs need.

**API returns 404 but pages load**
`vercel.json` is missing or wasn't committed. It must sit next to `package.json`.

**Function timeout on a big report**
Lower the `limit` query parameter, or narrow the date range. `maxDuration` is set to
30s in `vercel.json`; the Hobby plan allows up to 60.

---

## Before real users get the link

1. **Add authentication.** There is none right now — anyone with the URL sees everything.
   Vercel Password Protection is the quickest cover; Supabase Auth or NextAuth is the
   proper fix.
2. **Turn on partitioning** for `variant_history` once several months of data exist
   (see the note at the end of `db/schema.sql`).
3. **Lock the history table** so nothing can rewrite the past:

```sql
REVOKE UPDATE, DELETE ON variant_history FROM PUBLIC;
```

4. **Watch the free tiers.** Most managed Postgres free tiers are 0.5 GB, which 100 stores exceed on the base tables alone; Vercel Hobby is non-commercial.
   At 100 stores × ~15k change rows/day you will outgrow the free database in a few
   months — budget for the paid tier.
