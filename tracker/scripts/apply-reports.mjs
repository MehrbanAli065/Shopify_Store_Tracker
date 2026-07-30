/**
 * Create the audit_reports table. Additive and idempotent — it never touches
 * the tracker's own tables, so it is safe against a live database.
 *
 *   node scripts/apply-reports.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { exec, q, close, describe, MODE, ROOT } from '../lib/db.mjs'

console.log(`\n  target: ${describe()}  [${MODE}]\n`)
console.log('· applying db/reports.sql …')
await exec(fs.readFileSync(path.join(ROOT, 'db', 'reports.sql'), 'utf8'))

const cols = await q(`
  SELECT column_name FROM information_schema.columns
   WHERE table_name = 'audit_reports' ORDER BY ordinal_position`)
const n = await q(`SELECT count(*)::int AS n FROM audit_reports`)

console.log(`  audit_reports columns: ${cols.map(c => c.column_name).join(', ')}`)
console.log(`  rows already stored:   ${n[0].n}`)
console.log('\n✓ reports table ready\n')

await close()
