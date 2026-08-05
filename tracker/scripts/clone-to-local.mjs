/**
 * Copy the whole hosted database into the local one, so local work happens on
 * real data instead of an empty shell.
 *
 *   npm run db:clone
 *
 * The source is read from a commented-out DATABASE_URL in .env — the same line
 * you switch back to when you want production again — or from SOURCE_URL if you
 * would rather pass it explicitly. The target is whatever DATABASE_URL is
 * currently active.
 *
 * It refuses to run unless the target is on localhost. Getting the two the wrong
 * way round would overwrite production with a stale copy, and there is no undo
 * for that, so the check is not optional and not skippable by a flag.
 *
 * pg_dump is piped straight into psql: no file of production data is left lying
 * around afterwards to be forgotten or committed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { ROOT } from '../lib/db.mjs'

const LOCAL = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i

// ── find the binaries ─────────────────────────────────────────────
/** PATH first; a fresh install often isn't on the PATH of an already-open shell. */
function tool (name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  if (spawnSync(exe, ['--version'], { stdio: 'ignore' }).status === 0) return exe

  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\PostgreSQL'
    if (fs.existsSync(base)) {
      const versions = fs.readdirSync(base)
        .filter(v => /^\d+$/.test(v))
        .sort((a, b) => Number(b) - Number(a))          // newest first
      for (const v of versions) {
        const p = path.join(base, v, 'bin', exe)
        if (fs.existsSync(p)) return p
      }
    }
  }
  console.error(`\n  ✗ ${name} not found. Install the PostgreSQL command line tools, or add`)
  console.error(`    C:\\Program Files\\PostgreSQL\\<version>\\bin to PATH and open a new terminal.\n`)
  process.exit(1)
}

// ── work out source and target ────────────────────────────────────
const envPath = path.join(ROOT, '.env')
const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''

const TARGET = process.env.DATABASE_URL || process.env.POSTGRES_URL || ''

let SOURCE = process.env.SOURCE_URL || ''
if (!SOURCE) {
  // any commented-out DATABASE_URL that is not the local one
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*#\s*(?:DATABASE_URL|POSTGRES_URL)\s*=\s*(postgres(?:ql)?:\/\/\S+)/)
    if (!m) continue
    try {
      if (!LOCAL.test(new URL(m[1]).hostname)) { SOURCE = m[1].trim(); break }
    } catch { /* not a URL — ignore */ }
  }
}

const describe = u => {
  try { const x = new URL(u); return `${x.hostname}${x.pathname}` } catch { return '(unparseable)' }
}

if (!SOURCE) {
  console.error('\n  ✗ No source database found.')
  console.error('    Either leave the hosted DATABASE_URL in .env as a commented line,')
  console.error('    or pass it explicitly:  SOURCE_URL=postgresql://… npm run db:clone\n')
  process.exit(1)
}
if (!TARGET) {
  console.error('\n  ✗ No DATABASE_URL is set, so there is no target to write to.\n')
  process.exit(1)
}

let targetHost
try { targetHost = new URL(TARGET).hostname } catch {
  console.error('\n  ✗ DATABASE_URL is not a valid connection string.\n'); process.exit(1)
}

// The whole point of the script, and the one thing it must never get wrong.
if (!LOCAL.test(targetHost)) {
  console.error(`\n  ✗ Refusing to run: the target is ${describe(TARGET)}, which is not local.`)
  console.error('    This command overwrites the target completely. Point DATABASE_URL at')
  console.error('    localhost first, then run it again.\n')
  process.exit(1)
}
if (describe(SOURCE) === describe(TARGET)) {
  console.error('\n  ✗ Source and target are the same database.\n')
  process.exit(1)
}

console.log(`\n  from  ${describe(SOURCE)}`)
console.log(`  to    ${describe(TARGET)}\n`)
console.log('  copying — this overwrites everything in the local database …\n')

// ── dump straight into psql ───────────────────────────────────────
const pgDump = tool('pg_dump')
const psql   = tool('psql')

const dump = spawn(pgDump, [
  SOURCE,
  '--no-owner',            // local role names differ from Neon's
  '--no-privileges',
  '--clean', '--if-exists', // replace whatever is already there
  '--quote-all-identifiers',
], { stdio: ['ignore', 'pipe', 'pipe'] })

const restore = spawn(psql, [
  TARGET,
  '--quiet',
  '--set', 'ON_ERROR_STOP=off',   // DROPs for absent objects are noise, not failure
], { stdio: ['pipe', 'pipe', 'pipe'] })

dump.stdout.pipe(restore.stdin)

let dumpErr = '', restoreErr = ''
dump.stderr.on('data', d => { dumpErr += d })
restore.stderr.on('data', d => { restoreErr += d })
restore.stdout.on('data', () => {})

const done = p => new Promise(res => p.on('close', res))
const [dumpCode, restoreCode] = await Promise.all([done(dump), done(restore)])

// psql reports every DROP of a not-yet-existing object; those are expected here.
const realErrors = restoreErr
  .split('\n')
  .filter(l => /^psql:.*ERROR/.test(l) && !/does not exist/.test(l))

if (dumpCode !== 0) {
  console.error('  ✗ pg_dump failed:\n' + dumpErr.trim().split('\n').slice(-8).join('\n') + '\n')
  process.exit(1)
}
if (realErrors.length) {
  console.error('  ✗ restore reported errors:\n    ' + realErrors.slice(0, 8).join('\n    ') + '\n')
  process.exit(1)
}

// ── show what landed ──────────────────────────────────────────────
const { q, close } = await import('../lib/db.mjs')
const counts = await q(`
  SELECT 'stores' AS "table", count(*)::int AS rows FROM stores
  UNION ALL SELECT 'products',        count(*)::int FROM products
  UNION ALL SELECT 'variants',        count(*)::int FROM variants
  UNION ALL SELECT 'variant_history', count(*)::int FROM variant_history
  UNION ALL SELECT 'scrape_runs',     count(*)::int FROM scrape_runs`)
console.table(counts)

const runs = await q(`
  SELECT store_id::int, min(run_date)::text AS from, max(run_date)::text AS to, count(*)::int AS days
    FROM scrape_runs GROUP BY store_id ORDER BY store_id`)
console.table(runs)

// The function is not part of schema.sql, so a dump taken before it was applied
// would arrive without it. Say so rather than letting the next ingest fail.
const fn = await q(`
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ingest_store_day'`)
if (!fn.length) {
  console.log('  ! ingest_store_day() did not come across — run: npm run ingest:function\n')
} else {
  console.log('✓ local database now mirrors the hosted one\n')
}

await close()
