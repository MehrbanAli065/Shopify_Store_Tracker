/**
 * Creates the database from db/schema.sql and seeds the store registry.
 * Usage:  npm run init          (safe — errors if data already exists)
 *         npm run reset         (drops everything and rebuilds)
 */
import fs from 'node:fs'
import path from 'node:path'
import { exec, q, close, ROOT, DATA_DIR } from '../lib/db.mjs'

const force = process.argv.includes('--force')

if (force && fs.existsSync(DATA_DIR)) {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  console.log('· wiped existing database')
}

const schema = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8')
const seed   = fs.readFileSync(path.join(ROOT, 'db', 'seed.sql'),   'utf8')

console.log('· applying schema …')
await exec(schema)

console.log('· seeding stores …')
await exec(seed)

const tables = await q(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name`)

const stores = await q('SELECT id, name, domain, currency FROM stores ORDER BY id')

console.log('\n  Tables:', tables.map(t => t.table_name).join(', '))
console.log('  Stores:')
for (const s of stores) console.log(`    ${s.id} · ${s.name.padEnd(16)} ${s.domain}  [${s.currency}]`)
console.log(`\n✓ database ready at data/pgdata\n`)

await close()
