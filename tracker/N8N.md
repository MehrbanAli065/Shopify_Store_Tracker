# Running the nightly ingest from n8n

n8n replaces `scripts/nightly.bat` and Windows Task Scheduler. It does **not**
replace the ingest itself.

That distinction matters, so it is worth being explicit about it.

---

## What n8n should not do

The obvious n8n workflow — **Google Drive → Extract from File → Postgres** — looks
like it would work, and it does not. Three things break:

**The diff disappears.** `scripts/ingest.mjs` writes a `variant_history` row only
when a value actually changed. On real data that was 136 rows out of 7,558
variants — 1.8%. A Postgres node inserting every parsed row writes a full daily
snapshot instead: roughly 180M rows a year against 5.5M. The entire schema was
designed around avoiding that.

**Memory.** 100 stores at ~7,500 variants each is ~750,000 items passing through
n8n's item pipeline in one run. n8n holds items in memory between nodes.

**The safety rules go with it.** These live in `ingest.mjs` and have each already
caught a real bug:

| Rule | Line | What it caught |
|---|---|---|
| Collapsed-feed guard | [`ingest.mjs:217`](scripts/ingest.mjs#L217) | A half-empty scrape would have marked a whole store "removed" |
| `relisted` detection | [`ingest.mjs:283`](scripts/ingest.mjs#L283) | 205 Alkaram variants left the feed, came back, and stayed marked delisted |
| Record removal once | [`ingest.mjs:317`](scripts/ingest.mjs#L317) | 10 Brooklinen variants re-logged the same removal every night |
| Rewind on re-run | [`ingest.mjs:138`](scripts/ingest.mjs#L138) | Re-running a date used to stack a second set of history rows |

You could paste all of that into an n8n Code node. Then you would be maintaining
a second copy of the ingest inside a text box in a browser. Don't.

**So: n8n triggers `ingest-drive.mjs`, watches its exit code, and tells you when a
night breaks.** That is the whole job, and it is a genuinely useful one — right
now a failed night is only visible if someone opens Task Scheduler.

---

## Which option

| | Option A · Execute Command | Option B · HTTP endpoint |
|---|---|---|
| n8n runs | on the same machine as `tracker/` | anywhere |
| Needs a URL n8n can reach | no | yes — tunnel, unless n8n is on the same server |
| Credentials in n8n | none | one shared token |
| Setup | ~10 minutes | ~30 minutes |

**Option A if n8n can run next to the tracker, Option B otherwise.** Both are
built; pick by where n8n lives, not by preference.

> The deciding question is which machine the Execute Command node runs on. It
> runs on the **n8n server**, not on your laptop — so a hosted n8n at, say,
> `workflows.example.com` cannot see `E:\…\tracker` and Option A is out.
>
> Worth knowing before you choose: the ingest needs nothing that is specific to
> the Windows machine. Drive and Neon are both reached over the network. If the
> n8n server has shell access and Node 20+, moving `tracker/` there is the
> sturdiest arrangement of all — no tunnel, and it does not stop working when a
> desktop goes to sleep.

---

# Option A · Execute Command

## 1 · Prerequisites

**Node 20+** — already present (v24 on the current machine).

**A Drive service account.** The `.env` currently holds `GOOGLE_API_KEY`, and an
API key can only read. `--delete` needs write access, and `ingest-drive.mjs`
refuses the flag outright rather than half-working:

```
✗ An API key can only read, so --archive, --trash and --delete cannot work.
```

Follow [DRIVE.md](DRIVE.md) Option B — no new Google Cloud project needed. Then in
`tracker/.env`:

```
GOOGLE_APPLICATION_CREDENTIALS=C:/secure/tracker-ingest-key.json
```

Share the Drive folder with the key's `client_email` as **Editor**, not Viewer.
Verify before going near n8n:

```bash
npm run drive:check                  # should say "service account"
npm run ingest:drive -- --dry-run
```

> Once the service account works, `GOOGLE_API_KEY` can be removed and the Drive
> folder set back to **Restricted**.

## 2 · Install n8n

```powershell
npm install -g n8n
n8n start
```

Then open <http://localhost:5678>.

> Docker works too, but the container would need `tracker/` mounted **and** Node
> and the npm dependencies inside it. On Windows the global install is simpler.
>
> n8n Cloud **cannot** do this — the Execute Command node is disabled there. Use
> Option B.

To keep it running after logout, install it as a service with
[nssm](https://nssm.cc): `nssm install n8n "C:\Program Files\nodejs\n8n.cmd"`.

## 3 · Import the workflow

n8n → **Workflows → Import from File** → [`n8n/ingest-nightly.json`](n8n/ingest-nightly.json)

Four nodes:

```
Schedule (03:00 daily)
      ↓
Run ingest         scripts\n8n-ingest.bat   →  ingest-drive.mjs --delete
      ↓
Read the result    parses stdout into { ok, succeeded, failed, failedStores, text }
      ↓
IF ok  ── true ──→ Night OK
       └─ false ─→ Alert   ← attach Slack / Email / Telegram here
```

Check these two before activating:

- **`scripts/n8n-ingest.bat` → `APPDIR`** — must match this machine
- **Schedule → cron** — `0 3 * * *` is 03:00 in n8n's timezone
  (**Settings → Timezone**, set it to `Asia/Karachi`)

### Why a .bat wrapper instead of the command inline

[`scripts/n8n-ingest.bat`](scripts/n8n-ingest.bat) does three things that are
awkward to express in the Execute Command field:

**It always exits 0** and prints `EXITCODE=n` instead. n8n treats a non-zero exit
as a node failure and replaces the node's output with an error object — throwing
away stdout, which is where every per-store result lives. Since
`ingest-drive.mjs` deliberately exits 1 when any store fails, the inline version
would go blind exactly when something broke.

**It keeps `logs/ingest-YYYY-MM-DD.log`**, so the existing log habit still works
alongside n8n's execution history.

**It keeps the Windows path quoting in a file** rather than inside a JSON field
inside a browser field.

Run it by hand once before wiring up n8n:

```powershell
.\scripts\n8n-ingest.bat
```

## 4 · Test it

Hit **Execute Workflow** with the schedule bypassed. `Read the result` gives you:

```json
{
  "ok": true,
  "succeeded": 2,
  "failed": 0,
  "seconds": 47,
  "failedStores": [],
  "text": "Shopify ingest: 2 succeeded, 0 failed in 47s"
}
```

Then **Activate** the workflow.

## 5 · Attach a notifier

Replace the **Alert** NoOp with whatever you read. Every node gets the same
fields:

- `{{ $json.text }}` — one-line summary
- `{{ $json.failedStores }}` — the `✗` lines, per store
- `{{ $json.log }}` — last 4,000 characters of output

Telegram is the least setup: BotFather → token → Telegram node → `{{ $json.text }}`.

## 6 · Retire the old scheduler

Once a night has run green, disable the Task Scheduler entry pointing at
`nightly.bat`. Two schedulers running the same job is not harmful — the second
run finds every store already done and skips it — but the logs get confusing.

> `nightly.bat` uses `--archive`. The n8n workflow uses `--delete`, which is the
> one that actually frees Drive quota.

---

# Option B · HTTP endpoint

For n8n that lives somewhere else — a hosted instance, n8n Cloud, another server.

The route is built: [`lib/ingest-route.mjs`](lib/ingest-route.mjs), mounted from
`app.mjs`.

```
POST /api/ingest          start a run, answers 202 straight away
GET  /api/ingest/status   what the current or last run is doing
```

Both require an `X-Ingest-Token` header.

Two things are deliberate. **It answers 202 instead of waiting**, because a
100-store ingest runs for minutes and no proxy in between can be trusted to hold
an idle connection that long — n8n polls the status route instead. And **the
routes do not exist unless `INGEST_TOKEN` is set**: no token means no route,
rather than a route that exists and refuses. They also never mount on Vercel,
where the ingest could not work anyway.

The request body is validated into a fixed set of flags, so nothing a caller
sends reaches the command line as text:

```json
{ "cleanup": "delete", "concurrency": 3 }
```

`cleanup` is one of `delete` / `archive` / `trash` / `none`, `concurrency` is
1–10, `date` must be `YYYY-MM-DD`, `dryRun` is a boolean. Anything else is a 400.

> `cleanup` defaults to `none`, not `delete`. The other three need write access
> to Drive, and an API key does not have it — `ingest-drive.mjs` refuses the
> **entire run** rather than just skipping the tidy-up, and a fire-and-forget
> caller would never see it. Once a service account is in place, set
> `INGEST_CLEANUP=delete` in `.env` or send it in the body. Drive is at 98% and
> `delete` is the only setting that frees quota.

## 1 · Set the token

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put it in `tracker/.env` as `INGEST_TOKEN=…`. Anyone holding it can write to the
production database, so treat it like the database password.

## 2 · Run the tracker

```powershell
npm start          # http://localhost:3000
```

This has to stay running for n8n to reach it. On the UiPath VM, install it as a
service with [nssm](https://nssm.cc) so it survives a reboot.

## 3 · Give it a public URL

```powershell
cloudflared tunnel --url http://localhost:3000
```

Free, needs no inbound port opened, and survives the machine's IP changing. It
prints a `https://something.trycloudflare.com` URL.

> A quick tunnel gets a **new URL every restart**. For something that runs
> nightly, create a named tunnel bound to your own domain instead, or the n8n
> node will be pointing at a dead address by the second week.

If n8n runs on the *same* server as the tracker, skip the tunnel entirely and
point n8n at `http://localhost:3000` — or `http://host.docker.internal:3000` if
n8n is in Docker.

## 4 · Store the token in n8n

n8n → **Credentials → Create** → **Header Auth**

- Name: `X-Ingest-Token`
- Value: the token

Use the credential rather than typing the token into the node, so it does not end
up in the workflow's JSON export.

## 5 · Import a workflow

**Simple** — [`n8n/ingest-simple.json`](n8n/ingest-simple.json), two nodes:

```
Schedule (03:00) → POST /api/ingest
```

Fire and forget. The ingest runs on the tracker machine; results appear in the
tracker's own report pages.

**With alerting** — [`n8n/ingest-nightly-remote.json`](n8n/ingest-nightly-remote.json):

```
Schedule → POST /api/ingest → Wait 2m → GET /api/ingest/status
                                             ↓
                                  IF still running ─→ back to Wait
                                             ↓
                                  Read the result → IF ok → Alert
```

It gives up watching after 60 minutes and reports `timedOut`, so a hung ingest
does not leave an execution running forever.

Set the URL in the HTTP node(s) and attach the credential to each.

## 6 · Test it by hand first

Before involving n8n at all:

```powershell
curl -X POST http://localhost:3000/api/ingest `
  -H "X-Ingest-Token: YOUR_TOKEN" -H "Content-Type: application/json" `
  -d '{\"dryRun\":true,\"cleanup\":\"none\"}'

curl http://localhost:3000/api/ingest/status -H "X-Ingest-Token: YOUR_TOKEN"
```

`dryRun` lists what would happen and changes nothing — the safe way to prove the
token, the tunnel and the Drive credentials all work before a real run.

---

## Two things to fix regardless of option

**CSV filenames lost their date.** `dateFor()`
([`ingest-drive.mjs:58`](scripts/ingest-drive.mjs#L58)) reads the date out of the
filename and falls back to the file's Drive `modifiedTime` when there isn't one.
That fallback is only correct when the job runs the same day the file was
uploaded. Miss one night and a dateless file is recorded against the **wrong
day** — and `variant_history` is append-only, so fixing it means rewinding.

Automating the schedule makes a missed night more likely to go unnoticed, not
less. Get `YYYY-MM-DD` back into the scraper's filenames.

It also means files currently **overwrite each other on Drive**, so a missed night
loses that day's data entirely.

**Drive is at 98%.** Twelve more stores' CSVs would exceed it. `--delete` is what
fixes this; `--trash` does not, because trashed files still count against quota
until the trash is emptied. Deleting is safe — the database is the archive, and
rebuilding a past day from `variant_history` reproduces the original CSV counts
exactly.

---

## Troubleshooting

**`'node' is not recognized`** — n8n running as a service inherits the service
account's PATH, not yours. In `n8n-ingest.bat`, replace `node` with the full path:
`"C:\Program Files\nodejs\node.exe" scripts\ingest-drive.mjs --delete --concurrency 3`

**`exitCode` is 1 but some stores succeeded** — expected, and the reason the
wrapper exists. `ingest-drive.mjs` exits non-zero if *any* store failed; the ones
that worked are already committed to Postgres. `failedStores` names the rest, and
their files are left on Drive so the next run retries them.

**`nothing to do`, exit 0** — every store+date pair in the folder is already
recorded as `success` or `partial`. The workflow reports this as
`Nothing new on Drive` rather than a false success.

**Workflow times out** — n8n's default execution timeout can be shorter than a
100-store run. **Settings → Workflow settings → Timeout**, or set
`EXECUTIONS_TIMEOUT=-1`.

**Two runs overlap** — set **Settings → Workflow settings → Limit concurrency** to 1.
Ingest is safe to re-run, but two copies downloading the same files wastes Drive
quota reads.
