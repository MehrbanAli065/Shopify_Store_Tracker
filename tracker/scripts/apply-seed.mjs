/**
 * Apply db/seed.sql only — the safe way to add or rename stores.
 *
 *   npm run seed
 *
 * seed.sql upserts (ON CONFLICT DO UPDATE), so this never touches products,
 * variants, history or runs. Use it when stores 3–100 arrive.
 *
 * This exists because `migrate` starts with DROP TABLE … CASCADE: it builds a
 * database from nothing and would take every day of history with it. Adding a
 * store must never require that.
 */
import fs from 'node:fs'
import path from 'node:path'
import { exec, q, close, describe, MODE, ROOT } from '../lib/db.mjs'

console.log(`\n  target: ${describe()}  [${MODE}]\n`)

const before = await q('SELECT id, name, domain, csv_prefix, active FROM stores ORDER BY id')

console.log('· applying db/seed.sql …')
await exec(fs.readFileSync(path.join(ROOT, 'db', 'seed.sql'), 'utf8'))

const after = await q('SELECT id, name, domain, csv_prefix, active FROM stores ORDER BY id')
const was = new Map(before.map(s => [String(s.id), s]))

console.log('')
for (const s of after) {
  const old = was.get(String(s.id))
  const tag = !old ? 'added'
            : (old.name !== s.name || old.domain !== s.domain || old.csv_prefix !== s.csv_prefix)
              ? 'updated' : ''
  console.log(`  ${String(s.id).padStart(3)} · ${s.name.padEnd(20)} ${(s.csv_prefix || '—').padEnd(34)}` +
              (tag ? `  ${tag}` : ''))
}

// A store present in the database but absent from seed.sql is worth flagging —
// it stays and keeps its history, but the file no longer describes reality.
const seeded = new Set(after.map(s => String(s.id)))
const orphans = before.filter(s => !seeded.has(String(s.id)))
if (orphans.length) {
  console.log('\n  note: these exist in the database but are not in seed.sql —')
  console.log('        they are untouched, but add them to the file so it stays the record:')
  for (const s of orphans) console.log(`        ${s.id} · ${s.name}`)
}

console.log(`\n✓ ${after.length} store(s) registered · no product or history data touched\n`)
await close()
