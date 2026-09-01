/**
 * Push the schema + store registry to whichever database DATABASE_URL points at.
 *
 *   node scripts/migrate.mjs           apply schema.sql + seed.sql
 *   node scripts/migrate.mjs --check   just report what is already there
 *
 * Safe to run against the cloud DB before any ingest. schema.sql starts with
 * DROP … CASCADE, so re-running it wipes and rebuilds — that is intentional.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { q, exec, close, describe, MODE, ROOT } from '../lib/db.mjs'
import { SCHEMA_FILES } from '../lib/schema-files.mjs'

const check = process.argv.includes('--check')
const yes   = process.argv.includes('--yes')

console.log(`\n  target: ${describe()}  [${MODE}]\n`)

// what exists already?
const existing = await q(`
  SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)

if (existing.length) {
  console.log('  existing tables:', existing.map(t => t.table_name).join(', '))
  const counts = {}
  for (const t of existing.map(x => x.table_name)) {
    try { counts[t] = (await q(`SELECT count(*)::int AS n FROM ${t}`))[0].n } catch {}
  }
  console.log('  rows:', JSON.stringify(counts))
} else {
  console.log('  database is empty')
}

if (check) { await close(); process.exit(0) }

// destructive — confirm unless --yes
if (existing.length && !yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const a = await rl.question('\n  schema.sql DROPs these tables and rebuilds. Continue? (yes/no) ')
  rl.close()
  if (a.trim().toLowerCase() !== 'yes') { console.log('  aborted\n'); await close(); process.exit(1) }
}

for (const f of SCHEMA_FILES) {
  console.log(`· applying ${f} …`)
  await exec(fs.readFileSync(path.join(ROOT, 'db', f), 'utf8'))
}

const tables = await q(`
  SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)
const stores = await q('SELECT id, name, domain, currency FROM stores ORDER BY id')

console.log('\n  tables:', tables.map(t => t.table_name).join(', '))
console.log('  stores:')
for (const s of stores) console.log(`    ${s.id} · ${s.name.padEnd(16)} ${s.domain}  [${s.currency}]`)
console.log('\n✓ migration complete\n')

await close()
