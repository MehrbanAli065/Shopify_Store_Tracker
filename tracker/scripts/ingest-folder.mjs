/**
 * Ingest a whole folder of daily store CSVs — the nightly batch job.
 *
 *   node scripts/ingest-folder.mjs --dir "C:\path\to\Scrapped_Csv_Files"
 *
 * Options
 *   --dir <path>          folder to scan (required)
 *   --date YYYY-MM-DD     force the run date for every file
 *                         (default: read from the filename, else the file's mtime)
 *   --concurrency N       stores processed at once (default 3)
 *   --archive <path>      move each file here after a successful ingest
 *   --delete              delete each file after a successful ingest
 *   --dry-run             report the plan and change nothing
 *
 * Each store runs as its own child process, so one bad file can never take the
 * batch down — the other 99 keep going. Already-ingested store+date pairs are
 * skipped unless --force is given.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { q, close, describe, MODE } from '../lib/db.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── args ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = n => argv.includes(`--${n}`)
const opt  = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1] }

const DIR      = opt('dir')
const FORCEDAY = opt('date')
const CONC     = Math.max(1, Number(opt('concurrency', 3)))
const ARCHIVE  = opt('archive')
const DELETE   = flag('delete')
const DRY      = flag('dry-run')
const FORCE    = flag('force')

if (!DIR) { console.error('usage: --dir "<folder of CSVs>"  [--date YYYY-MM-DD] [--concurrency N]\n' +
                          '       [--archive <path> | --delete] [--dry-run] [--force]'); process.exit(1) }
if (!fs.existsSync(DIR)) { console.error(`folder not found: ${DIR}`); process.exit(1) }

// ── helpers ───────────────────────────────────────────────────────
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

/** Pull a date out of the filename; fall back to the file's own timestamp. */
function dateFor (file, full) {
  if (FORCEDAY) return FORCEDAY
  // 27_07_26 / 27-07-2026 / 2026-07-27  — day first unless the year leads
  let m = file.match(/(\d{4})[-_](\d{2})[-_](\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = file.match(/(\d{2})[-_](\d{2})[-_](\d{2,4})/)
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3]
    return `${yr}-${m[2]}-${m[1]}`
  }
  return iso(fs.statSync(full).mtime)
}

/** Longest matching csv_prefix wins, so similar domains cannot collide.
 *
 *  Both sides have their www dropped before comparing. The scraper stopped
 *  putting www in the filename on 7 Aug - 6 Aug has
 *  https___www_1822denim_com_shopify.csv and every day after it has
 *  https___1822denim_com_shopify.csv - while the sheet still spells 74 of the
 *  242 stores with www. Matching literally therefore skipped 70 files, 65 of
 *  them a whole day for stores that are very much in the sheet, and skipped
 *  them silently. Neither spelling is wrong, so neither is trusted.
 */
const noWww = s => s.toLowerCase().replace(/^https___www_/, 'https___')

function storeFor (file, stores) {
  const f = noWww(file)
  return stores
    .filter(s => s.csv_prefix && f.startsWith(noWww(s.csv_prefix)))
    .sort((a, b) => b.csv_prefix.length - a.csv_prefix.length)[0] || null
}

function runIngest (job) {
  return new Promise(resolve => {
    const args = ['--store', String(job.store.id), '--date', job.date, '--file', job.full]
    const child = spawn(process.execPath, [path.join(HERE, 'ingest.mjs'), ...args],
                        { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('close', code => resolve({ ...job, code, out }))
  })
}

/** Fixed-size worker pool. */
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

// ── plan ──────────────────────────────────────────────────────────
console.log(`\n  db     ${describe()}  [${MODE}]`)
console.log(`  folder ${DIR}\n`)

const stores = await q('SELECT id, name, domain, csv_prefix FROM stores WHERE active ORDER BY id')
const done   = new Set((await q(
  `SELECT store_id, run_date FROM scrape_runs WHERE status IN ('success','partial')`))
  .map(r => `${r.store_id}|${r.run_date}`))

const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.csv'))
const jobs = [], skipped = [], unmatched = []

for (const file of files) {
  const full = path.join(DIR, file)
  const store = storeFor(file, stores)
  if (!store) { unmatched.push(file); continue }

  const date = dateFor(file, full)
  if (!FORCE && done.has(`${store.id}|${date}`)) { skipped.push({ file, store, date }); continue }
  jobs.push({ file, full, store, date, size: fs.statSync(full).size })
}

console.log(`  ${files.length} CSV file(s) found`)
console.log(`  ${jobs.length} to ingest · ${skipped.length} already done · ${unmatched.length} unmatched\n`)

if (unmatched.length) {
  console.log('  ⚠ no store matches these files — add the store to db/seed.sql,')
  console.log('    or fix its csv_prefix so it matches the start of the filename:')
  for (const f of unmatched) console.log(`      ${f}`)
  console.log('')
}

if (DRY) {
  for (const j of jobs) {
    console.log(`  would ingest  store ${j.store.id} · ${j.date} · ${j.file} (${(j.size/1e6).toFixed(1)} MB)`)
  }
  await close(); process.exit(0)
}
if (!jobs.length) { console.log('  nothing to do\n'); await close(); process.exit(0) }

// ── run ───────────────────────────────────────────────────────────
const started = Date.now()
const results = await pool(jobs, CONC, runIngest)

// ── report ────────────────────────────────────────────────────────
const ok   = results.filter(r => r.code === 0)
const fail = results.filter(r => r.code !== 0)

console.log('\n  ── summary ──')
for (const r of ok) {
  const changes = (r.out.match(/changes recorded: (\d+)/) || [])[1] ?? '?'
  console.log(`  ✓ ${String(r.store.id).padStart(3)} ${r.store.name.padEnd(20)} ${r.date}  ${changes} changes`)
}
/** Node prints the message, then a stack, then its own version banner, so the
 *  last line is almost always "Node.js v24.15.0" and says nothing. Prefer the
 *  line that actually names the fault, and keep the tail of the output beneath
 *  it so a cause is never lost to a one-line summary again. */
const reason = out => {
  const ls = out.split('\n').map(l => l.trimEnd()).filter(l => l.trim())
  const named = ls.find(l => /[A-Za-z]*Error\b|error:|FATAL|out of memory/.test(l))
  return (named ?? ls[ls.length - 1] ?? 'no output').trim().slice(0, 160)
}

for (const r of fail) {
  console.log(`  ✗ ${String(r.store.id).padStart(3)} ${r.store.name.padEnd(20)} ${r.date}  FAILED — ${reason(r.out)}`)
  for (const l of r.out.split('\n').filter(l => l.trim()).slice(-12)) console.log(`        ${l.trimEnd()}`)
}
console.log(`\n  ${ok.length} succeeded · ${fail.length} failed · ${Math.round((Date.now()-started)/1000)}s\n`)

// ── tidy up only what actually succeeded ──────────────────────────
if (ARCHIVE || DELETE) {
  if (ARCHIVE) fs.mkdirSync(ARCHIVE, { recursive: true })
  let moved = 0
  for (const r of ok) {
    try {
      if (ARCHIVE) fs.renameSync(r.full, path.join(ARCHIVE, `${r.date}__${r.file}`))
      else fs.unlinkSync(r.full)
      moved++
    } catch (e) { console.log(`  ! could not tidy ${r.file}: ${e.message}`) }
  }
  console.log(`  ${ARCHIVE ? 'archived' : 'deleted'} ${moved} file(s)` +
              (fail.length ? `; left ${fail.length} failed file(s) in place\n` : '\n'))
}

// The store list reads its counts from store_rollup instead of recomputing
// them per request, which took ~19s once variants passed 4M rows. Refresh here,
// where the numbers have just changed and no browser is waiting.
if (ok.length) {
  const t0 = Date.now()
  process.stdout.write('  refreshing store counts ... ')
  try {
    await q('SELECT refresh_store_rollup()')
    console.log(`${Math.round((Date.now() - t0) / 1000)}s
`)
  } catch (e) {
    // Never fail an ingest over this. The data is in; the rollup is only a
    // cache, and a stale one shows old totals rather than wrong history.
    console.log(`
  ! could not refresh store counts: ${e.message}
`)
  }
}

await close()
process.exit(fail.length ? 1 : 0)
