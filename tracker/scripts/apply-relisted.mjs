/**
 * Widen the change_type constraint to allow 'relisted'.
 * Touches no rows; safe against a live database.
 *
 *   node scripts/apply-relisted.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { exec, q, close, describe, MODE, ROOT } from '../lib/db.mjs'

console.log(`\n  target: ${describe()}  [${MODE}]\n`)
await exec(fs.readFileSync(path.join(ROOT, 'db', 'relisted.sql'), 'utf8'))

const c = await q(`
  SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
   WHERE conname = 'variant_history_change_type_check'`)
console.log('  ' + (c[0]?.def || 'constraint not found'))
console.log('\n✓ relisted allowed\n')

await close()
