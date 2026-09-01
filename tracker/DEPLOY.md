# How this is deployed

Three pieces, on purpose in three places:

| Piece | Where | Why there |
|---|---|---|
| Pages | Vercel — `shopify-tracker-web` | Static HTML/CSS. Free HTTPS, and a login in front of it |
| API | Company server, `pm2` on port 3200 | Needs a persistent connection pool and long-running report queries |
| Database | PostgreSQL 16 on that same server | Next to the API, so a query is a socket away rather than an internet hop |
| Ingest | Your machine or the scraper VM | Reads multi-megabyte CSVs and takes minutes; not a web request |

```
browser ──HTTPS──▶ Vercel ──HTTP + shared token──▶ server:3200 ──socket──▶ PostgreSQL
          (pages)          (api/index.mjs proxy)      (Express)
```

## Why a proxy instead of calling the API directly

The pages are on `vercel.app` and the API is on the company server, so the browser
would be making a cross-origin call to a plain-HTTP host — which a HTTPS page is not
allowed to do at all, certificate or no certificate.

`api/index.mjs` on Vercel forwards `/api/*` and `/reports/*` to the server instead.
The browser only ever talks to Vercel, over HTTPS, on one origin. No CORS is involved,
and the shared token stays on the server side where the browser cannot read it.

## What guards it

The app itself has **no login**. Two things stand in for one, and neither is a
substitute for the real thing:

- **Vercel Authentication** — but read what it actually covers. It protects the
  hashed deployment URLs (`shopify-tracker-<hash>-<team>.vercel.app`) and **not**
  the production alias. `shopify-tracker-web.vercel.app` is open to anyone who has
  the link. Testing a hashed URL and seeing a login proves nothing about the alias.
- **`API_TOKEN`** on the server. Port 3200 is open to the internet — it has to be, for
  Vercel to reach it — so every `/api` and `/reports` request must carry
  `x-tracker-token`. Without it the answer is 401. Only the Vercel proxy holds it.

`/api/ingest` is deliberately outside that gate: the VM posts straight to the server
and has its own `INGEST_TOKEN`.

> Add a real login before showing this to anyone outside the Vercel team.

---

## The server

```bash
ssh mehrban@66.45.238.72
```

| | |
|---|---|
| App | `~/tracker`, run by `pm2` as `tracker` |
| Port | 3200, `HOST=0.0.0.0` (Vercel reaches it directly) |
| Config | `~/tracker/.env`, mode 600 |
| Database | `shopify_tracker_db`, user `tracker`, on localhost:5432 |
| Backups | `~/backup-db.sh` nightly at 02:30, seven kept in `~/backups` |

Apache holds ports 80/443 with 40 other sites on this machine and is **not** part of
this deployment. Do not change it without running `apache2ctl configtest` first.

### Everyday commands

```bash
pm2 status                       # is it up
pm2 logs tracker --lines 50      # what it is saying
pm2 restart tracker --update-env # after editing .env
tail -5 ~/backups/backup.log     # did last night's backup run
```

### Pushing new code

From `tracker/` on your machine:

```bash
tar czf - --exclude=node_modules --exclude=.env --exclude=vercel-site \
    app.mjs server.mjs package.json package-lock.json lib db scripts public api \
  | ssh mehrban@66.45.238.72 'tar xzf - -C ~/tracker && cd ~/tracker \
      && npm install --omit=dev && pm2 restart tracker --update-env'
```

`.env` is excluded on purpose — the server's copy differs from yours.

---

## The frontend

The Vercel project is **connected to this GitHub repo**, so every push to `main`
triggers a production build. That is why `vercel-site/` is committed rather than
gitignored: a git build only sees what is in the repo.

> The project's **Root Directory** must be `tracker/vercel-site`. Without it a push
> builds from the repo root, produces nothing usable, and the site 404s until
> someone deploys again by hand. That has already happened once.

`vercel-site/` is assembled, not edited. The pages live in `public/` because that is
where Express serves them from; Vercel wants static files at the root and functions
under `api/`, so the shape it expects is built. Rebuild it and commit the result in
the same change as any edit to `public/`:

```bash
node scripts/build-vercel-site.mjs
cd vercel-site
npx vercel deploy --prod --scope techbugs-projects-a51e618e
```

Two environment variables must exist on the Vercel project, and they are what make
the proxy work:

| Name | Value |
|---|---|
| `TRACKER_API_ORIGIN` | `http://66.45.238.72:3200` |
| `TRACKER_API_TOKEN` | must equal `API_TOKEN` in the server's `.env` |

```bash
printf '%s' "$TOKEN" | npx vercel env add TRACKER_API_TOKEN production
```

If the dashboard loads but every panel is empty, these two are the first thing to
check: a mismatched token gives 401 on every call and an empty page with no error.

---

## Restoring the database

```bash
ssh mehrban@66.45.238.72
zcat ~/backups/tracker-YYYY-MM-DD.sql.gz | psql -h localhost -U tracker -d shopify_tracker_db
```

Into a fresh, empty database. The dumps are plain SQL so `psql` alone is enough —
which is the point, on a machine you have just had to rebuild.

To build the schema without any data — a new environment, or a test:

```bash
npm run migrate       # applies every file in lib/schema-files.mjs, in order
```

That list is the single source of truth for what a complete database contains.
Adding a table means adding its `.sql` file to it, or a rebuild will silently
come out missing it.

---

## Ingest

Ingest never runs on Vercel — it reads CSVs from disk and takes minutes for 100
stores, while a Vercel function has neither a filesystem nor that much time.

Point `DATABASE_URL` at the server and run it from wherever the CSVs are:

```
DATABASE_URL=postgresql://tracker:PASSWORD@66.45.238.72:5432/shopify_tracker_db
```

> PostgreSQL on that server currently listens on **localhost only**. To ingest from
> your machine, either run ingest over SSH on the server, or open 5432 to your IP
> specifically — never to the whole internet.

See [`VM-SETUP.md`](VM-SETUP.md) for running it on the scraper VM and
[`DRIVE.md`](DRIVE.md) for pulling the CSVs from Drive.
