# Deploying to Vercel

## Read this first

The app currently runs on **PGlite** — a Postgres that lives in a file under `data/`.
That cannot go to Vercel: serverless functions get a **read-only, throwaway filesystem**,
so the database would be empty on every request.

So deployment is two things, not one:

| Piece | Where it goes |
|---|---|
| Frontend + API | **Vercel** |
| Database | **Hosted Postgres** (Neon or Supabase — both have a free tier) |
| Ingest (CSV → DB) | **Stays off Vercel.** Run it from your machine or the UiPath VM |

> **Why ingest cannot run on Vercel:** it reads multi-megabyte CSVs from disk and takes
> minutes for 100 stores. Vercel functions cap at 30–60s and have no file access. Ingest
> is a batch job — it belongs next to wherever the CSVs land.

The code is already dual-mode. Set `DATABASE_URL` and it uses hosted Postgres; leave it
unset and it uses the local PGlite file. Nothing else changes.

---

## Step 1 · Create a hosted Postgres

**Neon** is the easiest for this (recommended):

1. Go to <https://neon.tech> → sign up → **Create project**
2. Name it `shopify-tracker`, pick the region nearest your users
3. On the dashboard open **Connection Details**
4. Select **Pooled connection** and copy the string. It looks like:

```
postgresql://user:PASSWORD@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require
```

> Use the **pooled** (`-pooler`) endpoint. Serverless functions open many short
> connections and a direct endpoint will run out.

**Supabase** works identically — *Project Settings → Database → Connection string →
**Transaction pooler***. Take that one, not the direct connection.

---

## Step 2 · Point your machine at it and create the tables

In the `tracker/` folder:

```bash
cp .env.example .env
```

Open `.env` and paste your connection string:

```
DATABASE_URL=postgresql://user:PASSWORD@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require
```

Check the connection:

```bash
npm run migrate:check
```

You should see `target: PostgreSQL · ep-xxx… [postgres]` and `database is empty`.

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

The banner should now read `db PostgreSQL · ep-xxx… [postgres]`. Open
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
Neon / Supabase
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
You are on the direct endpoint. Switch to the pooled one (`-pooler` on Neon,
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

4. **Watch the free tiers.** Neon free is 0.5 GB; Vercel Hobby is non-commercial.
   At 100 stores × ~15k change rows/day you will outgrow the free database in a few
   months — budget for the paid tier.
