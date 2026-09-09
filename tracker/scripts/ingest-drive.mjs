/**
 * The nightly job: read the day's CSVs straight out of the Drive folder,
 * ingest each one, and tidy up. This is the real entry point — nothing is
 * read from a local project path.
 *
 *   node scripts/ingest-drive.mjs
 *   node scripts/ingest-drive.mjs --dry-run
 *   node scripts/ingest-drive.mjs --archive        (move into Drive/Ingested/)
 *   node scripts/ingest-drive.mjs --trash          (send to Drive trash)
 *   node scripts/ingest-drive.mjs --delete         (remove for good, frees quota)
 *
 * Options
 *   --folder <id|url>    override DRIVE_FOLDER_ID
 *   --date YYYY-MM-DD    force the run date for every file
 *   --concurrency N      stores at once (default 3)
 *   --archive            move each ingested file into an "Ingested" subfolder
 *   --trash              send each ingested file to the Drive trash instead
 *   --delete             delete each ingested file outright — trashed files still
 *                        count against Drive storage until the trash is emptied
 *   --keep               leave the downloaded copies in data/drive-cache
 *   --dry-run            list what would happen, touch nothing
 *   --force              re-ingest dates already recorded
 *
 * Each store runs as its own child process, so one bad file cannot take the
 * batch down. Files that fail are left in Drive for the next run to retry.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * A last resort, not a way of carrying on. Anything that reaches here is a
 * fault nobody anticipated, and the run cannot be trusted to continue — but it
 * can end with a line that says what happened instead of a bare stack trace in
 * a log nobody reads at 7am. The nightly mail reports from the database, so a
 * run that dies here is still counted honestly: whatever went in, went in.
 */
for (const sig of ['unhandledRejection', 'uncaughtException']) {
  process.on(sig, err => {
    console.error(`\n  ✗ ${sig}: ${err?.message || err}`)
    if (err?.stack) console.error(String(err.stack).split('\n').slice(1, 4).join('\n'))
    console.error('    The run stopped here. Files not yet ingested are still in Drive.\n')
    process.exit(1)
  })
}
import { q, close, describe, MODE, ROOT } from '../lib/db.mjs'
import { folderId, describeAuth, readOnlyAuth, listCsvFiles, listDayFolders,
         downloadFile, trashFile, deleteFile, moveFile, ensureFolder } from '../lib/drive.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── args ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = n => argv.includes(`--${n}`)
const opt  = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1] }

const FOLDER   = folderId(opt('folder') || process.env.DRIVE_FOLDER_ID)
const FORCEDAY = opt('date')
const CONC     = Math.max(1, Number(opt('concurrency', 3)))
const ARCHIVE  = flag('archive')
const TRASH    = flag('trash')
const DELETE   = flag('delete')
const KEEP     = flag('keep')
const DRY      = flag('dry-run')
const FORCE    = flag('force')

const CACHE = path.join(ROOT, 'data', 'drive-cache')

// ── helpers ───────────────────────────────────────────────────────
const iso = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

/** Date from the filename if it carries one, else the file's own Drive timestamp. */
function dateFor (name, modifiedTime) {
  if (FORCEDAY) return FORCEDAY
  let m = name.match(/(\d{4})[-_](\d{2})[-_](\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = name.match(/(\d{2})[-_](\d{2})[-_](\d{2,4})/)
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2]}-${m[1]}`
  return iso(new Date(modifiedTime))
}

/** Longest matching csv_prefix wins, so similar domains cannot collide.
 *
 *  Both sides have their www dropped before comparing, exactly as
 *  ingest-folder.mjs does. The scraper stopped putting www in the filename on
 *  7 Aug while the sheet still spells 74 of the 242 stores with it, and
 *  matching literally skipped 70 files, 65 of them a whole day, in silence.
 *  This file was missing the rule that file already had.
 */
const noWww = s => String(s).toLowerCase().replace(/^https___www_/, 'https___')

function storeFor (name, stores) {
  const f = noWww(name)
  return stores
    .filter(s => s.csv_prefix && f.startsWith(noWww(s.csv_prefix)))
    .sort((a, b) => b.csv_prefix.length - a.csv_prefix.length)[0] || null
}

/**
 * A store the size of The Dress Outlet — 382 MB of CSV, 556,000 variants — sits
 * right at Node's default heap ceiling. It went in fine on 4, 5 and 6 September
 * and then died on the 7th and the 8th with nothing in the log but Node's own
 * version banner, which is the last line a heap crash prints. Run on its own
 * afterwards, on the same day's file, it succeeded in one go.
 *
 * So the big ones get room: a heap sized to the file rather than to the
 * default. Small stores are left alone — they do not need it, and handing every
 * one of 240 processes a 3 GB ceiling on a 7.9 GB machine invites the kernel to
 * start killing things instead.
 */
const BIG_MB = 200

function runIngest (job) {
  return new Promise(resolve => {
    const heap = Number(job.mb) > BIG_MB ? ['--max-old-space-size=3072'] : []
    const child = spawn(process.execPath,
      [...heap, path.join(HERE, 'ingest.mjs'), '--store', String(job.store.id),
       '--date', job.date, '--file', job.local],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('close', code => resolve({ ...job, code, out }))
  })
}

async function pool (jobs, n, fn) {
  const results = []
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (i < jobs.length) {
      const job = jobs[i++]
      process.stdout.write(`  → ${job.store.name} (${job.date})\n`)
      results.push(await fn(job))
    }
  }))
  return results
}

// ── preflight ─────────────────────────────────────────────────────
if (!FOLDER) {
  console.error('\n  ✗ No Drive folder. Set DRIVE_FOLDER_ID in .env, or pass --folder <id|url>.\n')
  process.exit(1)
}

const auth = describeAuth()
if (!auth) {
  console.error([
    '',
    '  ✗ No Google credentials found. Pick the simplest one that fits:',
    '',
    '    GOOGLE_API_KEY                  — folder shared as "Anyone with the link"',
    '    GOOGLE_APPLICATION_CREDENTIALS  — service account key, folder shared with it',
    '    GOOGLE_OAUTH_* trio             — reuse an existing OAuth app',
    '',
    '    DRIVE.md walks through each.',
    ''
  ].join('\n'))
  process.exit(1)
}

// An API key can read, and that is all. Say so before any work happens.
if ((ARCHIVE || TRASH || DELETE) && readOnlyAuth()) {
  console.error([
    '',
    '  ✗ An API key can only read, so --archive, --trash and --delete cannot work.',
    '    Drop the flag — already-ingested days are skipped anyway — or use a',
    '    service account.',
    ''
  ].join('\n'))
  process.exit(1)
}

console.log(`\n  db     ${describe()}  [${MODE}]`)
console.log(`  drive  folder ${FOLDER}`)
console.log(`  auth   ${auth}\n`)

// ── which day's folder ────────────────────────────────────────────
// The CSVs are not loose in DRIVE_FOLDER_ID. The scraper makes one folder per
// day, named YYYY-MM-DD, and puts that day's files inside it. Listing the
// parent and filtering out folders — which is what this did — therefore found
// the Shopify_Scraper sheet, no CSVs at all, and reported "0 files" as though
// that were a normal night. It never ingested anything.
//
// The folder's name is also the run date. That is better than reading it off
// the filename or the file's modifiedTime: most filenames carry no date, and a
// file uploaded after midnight carries the next day's timestamp, which dated a
// whole night of stores to the wrong day.
const TZ = process.env.DRIVE_TZ || 'Asia/Karachi'

let dayFolder
try {
  const folders = await listDayFolders(FOLDER)     // newest first
  if (!folders.length) {
    console.error(`\n  ✗ no YYYY-MM-DD folder inside ${FOLDER} — nothing to ingest\n`)
    await close(); process.exit(1)
  }
  const want  = FORCEDAY || new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
  const exact = folders.find(f => f.name === want)
  dayFolder = exact || folders[0]
  if (!exact) {
    // Falling back rather than stopping: a run a few minutes after midnight, or
    // a scraper that finished late, should still ingest the day that is there.
    console.log(`  note   no folder named ${want}; using the newest, ${dayFolder.name}`)
  }
} catch (e) {
  console.error(`  ✗ could not list the day folders: ${e.message}\n`)
  await close(); process.exit(1)
}

console.log(`  day    ${dayFolder.name}`)

// ── list ──────────────────────────────────────────────────────────
let files
try {
  files = await listCsvFiles(dayFolder.id)
} catch (e) {
  console.error(`  ✗ could not list ${dayFolder.name}: ${e.message}\n`)
  await close(); process.exit(1)
}

// Everything else in this run is wrapped; these two were not, and a database
// that is down or still starting would end the night with a stack trace rather
// than a sentence.
let stores, done
try {
  stores = await q('SELECT id, name, domain, csv_prefix FROM stores WHERE active ORDER BY id')
  done = new Set((await q(
    `SELECT store_id, run_date FROM scrape_runs WHERE status IN ('success','partial')`))
    .map(r => `${r.store_id}|${r.run_date}`))
} catch (e) {
  console.error(`  ✗ could not read the database: ${e.message}`)
  console.error('    Nothing was ingested. The files are still in Drive.\n')
  await close(); process.exit(1)
}

const jobs = [], skipped = [], unmatched = []
for (const f of files) {
  const store = storeFor(f.name, stores)
  if (!store) { unmatched.push(f); continue }
  // The folder is the day. dateFor() stays for --date and for any file that
  // is somehow read outside a dated folder.
  const date = FORCEDAY || dayFolder.name || dateFor(f.name, f.modifiedTime)
  if (!FORCE && done.has(`${store.id}|${date}`)) { skipped.push({ f, store, date }); continue }
  jobs.push({ f, store, date, mb: (Number(f.size || 0) / 1e6).toFixed(1) })
}

console.log(`  ${files.length} CSV file(s) in the folder`)
console.log(`  ${jobs.length} to ingest · ${skipped.length} already done · ${unmatched.length} unmatched\n`)

if (unmatched.length) {
  console.log('  ⚠ no store matches these — add the store to db/seed.sql, or fix its')
  console.log('    csv_prefix so it matches the start of the filename:')
  for (const f of unmatched) console.log(`      ${f.name}`)
  console.log('')
}
if (skipped.length && DRY) {
  for (const s of skipped) console.log(`  skip   store ${s.store.id} · ${s.date} · ${s.f.name}`)
}

if (DRY) {
  for (const j of jobs) {
    console.log(`  would ingest  store ${j.store.id} · ${j.date} · ${j.f.name} (${j.mb} MB)`)
  }
  if (ARCHIVE || TRASH || DELETE)
    console.log(`\n  then ${DELETE ? 'DELETE' : TRASH ? 'trash' : 'archive'} each ingested file on Drive`)
  console.log('')
  await close(); process.exit(0)
}
if (!jobs.length) { console.log('  nothing to do\n'); await close(); process.exit(0) }

// ── download ──────────────────────────────────────────────────────
fs.mkdirSync(CACHE, { recursive: true })
console.log('  downloading …')
for (const j of jobs) {
  j.local = path.join(CACHE, `${j.store.id}__${j.date}__${j.f.name.replace(/[\\/:*?"<>|]/g, '_')}`)
  try {
    const bytes = await downloadFile(j.f.id, j.local)
    console.log(`    ${j.f.name}  ${(bytes / 1e6).toFixed(1)} MB`)
  } catch (e) {
    j.downloadError = e.message
    console.log(`    ${j.f.name}  ✗ ${e.message}`)
  }
}
const ready = jobs.filter(j => !j.downloadError)
if (!ready.length) { console.log('\n  nothing downloaded\n'); await close(); process.exit(1) }

// ── ingest ────────────────────────────────────────────────────────
console.log('')
const started = Date.now()
// The heaviest files run first and alone. Three 3 GB ceilings side by side do
// not fit in 7.9 GB, and the machine is at its emptiest before the rest start.
const heavy = ready.filter(j => Number(j.mb) > BIG_MB)
const rest  = ready.filter(j => Number(j.mb) <= BIG_MB)
if (heavy.length) console.log(`  ${heavy.length} large file(s) first, one at a time\n`)
const results = [
  ...await pool(heavy, 1, runIngest),
  ...await pool(rest, CONC, runIngest),
]

const ok   = results.filter(r => r.code === 0)
const fail = results.filter(r => r.code !== 0)

console.log('\n  ── summary ──')
for (const r of ok) {
  const changes = (r.out.match(/changes recorded: (\d+)/) || [])[1] ?? '?'
  console.log(`  ✓ ${String(r.store.id).padStart(3)} ${r.store.name.padEnd(20)} ${r.date}  ${changes} changes`)
}
for (const r of fail) {
  const why = (r.out.trim().split('\n').filter(Boolean).pop() || '').slice(0, 90)
  console.log(`  ✗ ${String(r.store.id).padStart(3)} ${r.store.name.padEnd(20)} ${r.date}  FAILED — ${why}`)
}
for (const j of jobs.filter(j => j.downloadError)) {
  console.log(`  ✗ ${String(j.store.id).padStart(3)} ${j.store.name.padEnd(20)} ${j.date}  DOWNLOAD FAILED`)
}
console.log(`\n  ${ok.length} succeeded · ${fail.length + (jobs.length - ready.length)} failed · ` +
            `${Math.round((Date.now() - started) / 1000)}s\n`)

// ── tidy up, only what actually succeeded ──────────────────────────
if (ok.length && (ARCHIVE || TRASH || DELETE)) {
  let moved = 0
  const dest = ARCHIVE ? await ensureFolder('Ingested', FOLDER) : null
  for (const r of ok) {
    try {
      if (DELETE)     await deleteFile(r.f.id)
      else if (TRASH) await trashFile(r.f.id)
      else            await moveFile(r.f.id, dest, FOLDER)
      moved++
    } catch (e) { console.log(`  ! could not tidy ${r.f.name}: ${e.message}`) }
  }
  const verb = DELETE ? 'deleted' : TRASH ? 'trashed' : 'archived'
  console.log(`  ${verb} ${moved} file(s) on Drive` +
              (fail.length ? `; left ${fail.length} failed file(s) in place` : '') + '\n')
  if (TRASH) console.log('  note: trashed files still use Drive storage until the trash is emptied\n')
}

if (!KEEP) {
  for (const r of results) { try { fs.unlinkSync(r.local) } catch {} }
} else {
  console.log(`  downloaded copies kept in ${path.relative(ROOT, CACHE)}\n`)
}

await close()
process.exit(fail.length || jobs.length !== ready.length ? 1 : 0)
