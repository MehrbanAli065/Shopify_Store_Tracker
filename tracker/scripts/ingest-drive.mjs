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
import { q, close, describe, MODE, ROOT } from '../lib/db.mjs'
import { folderId, describeAuth, readOnlyAuth, listCsvFiles, downloadFile,
         trashFile, deleteFile, moveFile, ensureFolder } from '../lib/drive.mjs'

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

/** Longest matching csv_prefix wins, so similar domains cannot collide. */
function storeFor (name, stores) {
  const n = name.toLowerCase()
  return stores
    .filter(s => s.csv_prefix && n.startsWith(s.csv_prefix.toLowerCase()))
    .sort((a, b) => b.csv_prefix.length - a.csv_prefix.length)[0] || null
}

function runIngest (job) {
  return new Promise(resolve => {
    const child = spawn(process.execPath,
      [path.join(HERE, 'ingest.mjs'), '--store', String(job.store.id),
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

// ── list ──────────────────────────────────────────────────────────
let files
try {
  files = await listCsvFiles(FOLDER)
} catch (e) {
  console.error(`  ✗ could not list the folder: ${e.message}\n`)
  await close(); process.exit(1)
}

const stores = await q('SELECT id, name, domain, csv_prefix FROM stores WHERE active ORDER BY id')
const done   = new Set((await q(
  `SELECT store_id, run_date FROM scrape_runs WHERE status IN ('success','partial')`))
  .map(r => `${r.store_id}|${r.run_date}`))

const jobs = [], skipped = [], unmatched = []
for (const f of files) {
  const store = storeFor(f.name, stores)
  if (!store) { unmatched.push(f); continue }
  const date = dateFor(f.name, f.modifiedTime)
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
const results = await pool(ready, CONC, runIngest)

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
