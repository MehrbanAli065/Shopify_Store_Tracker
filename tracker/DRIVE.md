# Ingesting from Google Drive

The daily CSVs live in a Drive folder, and that folder is the source of truth.
`scripts/ingest-drive.mjs` lists it, downloads what is new, ingests each store,
and tidies up. Nothing is read from a local project path.

```bash
npm run ingest:drive -- --dry-run     # see the plan, change nothing
npm run ingest:drive -- --archive     # ingest, then move files to Drive/Ingested/
```

Google needs to know who is asking, so this needs credentials once. Pick **one**
of the two options below — the service account is the right one for a nightly job
because it never involves a browser.

---

## Option A · API key — the smallest setup

Two minutes, nothing expires, no service account and nothing to share with a robot.

### 1 · Make the folder link-readable

Drive → open the folder → **Share** → **Anyone with the link** → **Viewer**

> This does mean anyone holding the link can read the CSVs. They are scraped
> public product data, so that is usually fine — but it is your call.

### 2 · Create the key

1. <https://console.cloud.google.com> → **Select a project** → **New project** → `shopify-tracker`
2. Search **Google Drive API** → open it → **Enable**
3. **APIs & Services → Credentials** → **Create credentials** → **API key** → copy it

### 3 · Put it in `.env`

```
DRIVE_FOLDER_ID=https://drive.google.com/drive/folders/18pys1Pn4EHeycwWWvtj5StiqqFQTYTEs
GOOGLE_API_KEY=AIza...
```

### 4 · Check, then run

```bash
npm run drive:check          # names the exact problem if there is one
npm run ingest:drive         # the whole folder, into the database
```

An API key can only read, so `--archive` and `--trash` are unavailable. That is
fine — files can stay in Drive, because finished store + date pairs are skipped.

---

## Option B · Service account (better for an unattended job)

One-time, about five minutes.

### 1 · Create the project and enable the API

1. Go to <https://console.cloud.google.com>
2. Top bar → **Select a project** → **New project** → name it `shopify-tracker` → **Create**
3. Search **Google Drive API** → open it → **Enable**

### 2 · Create the service account

1. Left menu → **IAM & Admin → Service Accounts** → **Create service account**
2. Name: `tracker-ingest` → **Create and continue** → skip the optional roles → **Done**
3. Click the account → **Keys** tab → **Add key → Create new key → JSON** → **Create**

A `.json` file downloads. **That file is a credential — treat it like a password.**
Keep it outside the repo, or somewhere `.gitignore` already covers.

### 3 · Share the Drive folder with it

Open the JSON and copy `client_email` — it looks like:

```
tracker-ingest@shopify-tracker-123456.iam.gserviceaccount.com
```

Then in Drive:

1. Open the CSV folder
2. **Share** → paste that address
3. Give it **Viewer** if you only want to read.
   Give it **Editor** if you want `--archive` or `--trash` to work, since both
   modify the files.
4. **Send** (uncheck "notify people" — it is not a mailbox)

> A service account is not you. Until the folder is shared with it, Drive will
> answer 404 as though the folder does not exist. The script says as much when
> that happens.

### 4 · Point the app at it

In `tracker/.env`:

```
DRIVE_FOLDER_ID=https://drive.google.com/drive/folders/18pys1Pn4EHeycwWWvtj5StiqqFQTYTEs
GOOGLE_APPLICATION_CREDENTIALS=C:\secure\tracker-ingest-key.json
```

The folder id or the whole folder URL both work.

### 5 · Check it

```bash
npm run ingest:drive -- --dry-run
```

Expected:

```
  drive  folder 18pys1Pn4EHeycwWWvtj5StiqqFQTYTEs
  auth   service account (tracker-ingest-key.json)

  2 CSV file(s) in the folder
  1 to ingest · 1 already done · 0 unmatched

  would ingest  store 1 · 2026-07-29 · https___www_alkaramstudio_com__shopify.csv (3.9 MB)
```

Then drop `--dry-run` to do it for real.

---

## Option C · OAuth refresh token

Use this if you would rather reuse the same Google app the Python uploader
already uses (`For Python/settings.yaml`). It is equally headless once the
refresh token exists, but there are more moving parts.

You need three values in `.env`:

```
GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=…
GOOGLE_OAUTH_REFRESH_TOKEN=1//…
```

The client id and secret come from `client_secrets.json`. The refresh token is
in `mycreds.txt` after the Python uploader has logged in once — it is the
`refresh_token` field.

Unlike a service account, this acts as **you**, so nothing needs to be shared:
whatever you can see in Drive, the job can see.

---

## What the job does

| Step | Behaviour |
|---|---|
| List | every `.csv` directly inside the folder, subfolders ignored |
| Match | filename start vs each store's `csv_prefix`; longest match wins |
| Date | from the filename (`28_07_26`, `2026-07-28`, `28-07-2026`), else the file's Drive `modifiedTime` |
| Skip | any store + date already recorded as `success` or `partial` |
| Download | to `data/drive-cache/`, deleted afterwards unless `--keep` |
| Ingest | one child process per store, `--concurrency` at a time (default 3) |
| Tidy | `--archive` moves to a `Ingested` subfolder · `--trash` sends to Drive trash |

Safeguards, same as the local folder job:

- **Unmatched files are reported, never guessed at.** A file whose prefix matches
  no store is listed and left alone.
- **Only files that actually succeeded are archived or trashed.** Failures stay
  in the folder so the next run retries them.
- **Re-running is harmless** — finished store + date pairs are skipped.

> **Keep the date in the filename.** The `modifiedTime` fallback is only correct
> when the job runs the same day the file was uploaded. If a night is missed, a
> dateless file will be recorded against the wrong day.

---

## Scheduling it

`scripts/nightly.bat` runs this job. Edit the path at the top, then create a
daily task in Windows Task Scheduler pointing at it. It writes a per-day log
under `logs/` and exits non-zero if any store failed, so a broken night shows up
in the task history instead of passing silently.

---

## Troubleshooting

**`Drive returned 404. Is the folder shared with the credential?`**
Service accounts see nothing by default. Share the folder with the account's
`client_email` (step 3).

**`Drive 403: Insufficient permission`** with `--archive` or `--trash`
Those modify files. Re-share the folder as **Editor**, not Viewer.

**`0 CSV file(s) in the folder`**
Either the folder id is wrong, or the files sit in a subfolder — only files
directly inside the folder are listed.

**`No store matches these files`**
Add the store to `db/seed.sql` and run `npm run migrate`, or correct its
`csv_prefix` so it matches the start of the filename.

**Everything says "already done"**
That is the skip working. Pass `--force` to re-ingest, remembering that
re-ingesting anything other than a store's newest date is refused.
