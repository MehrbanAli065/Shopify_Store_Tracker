/**
 * Re-apply db/ingest-function.sql to whichever database is configured.
 * Safe on a live database — it only creates or replaces two functions and
 * touches no table and no row.
 *
 *   npm run ingest:function
 */
import fs from 'node:fs'
import path from 'node:path'
import { exec, q, close, describe, MODE, ROOT } from '../lib/db.mjs'

console.log(`\n  target: ${describe()}  [${MODE}]\n`)
console.log('· applying db/ingest-function.sql …')
await exec(fs.readFileSync(path.join(ROOT, 'db', 'ingest-function.sql'), 'utf8'))

const fns = await q(`
  SELECT p.proname AS name, pg_get_function_result(p.oid) AS returns
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('ingest_store_day', 'safe_ts')
   ORDER BY p.proname`)

console.table(fns)
console.log(fns.length === 2 ? '✓ ingest function applied\n' : '✗ expected 2 functions\n')

await close()
process.exit(fns.length === 2 ? 0 : 1)
