/**
 * Re-apply db/views.sql to whichever database is configured.
 * Safe on a live database — it only drops and recreates views/functions,
 * never tables or data.
 *
 *   npm run views
 */
import fs from 'node:fs'
import path from 'node:path'
import { exec, q, close, describe, MODE, ROOT } from '../lib/db.mjs'

console.log(`\n  target: ${describe()}  [${MODE}]\n`)
console.log('· applying db/views.sql …')
await exec(fs.readFileSync(path.join(ROOT, 'db', 'views.sql'), 'utf8'))

const cols = await q(`
  SELECT column_name FROM information_schema.columns
   WHERE table_name = 'v_change_report' AND column_name = 'is_baseline'`)

const counts = await q(`
  SELECT store_id,
         COUNT(*) FILTER (WHERE change_type = 'new' AND is_baseline)::int      AS baseline,
         COUNT(*) FILTER (WHERE change_type = 'new' AND NOT is_baseline)::int  AS genuinely_new
    FROM v_change_report GROUP BY store_id ORDER BY store_id`)

console.log(`  is_baseline column present: ${cols.length ? 'yes' : 'NO'}`)
console.table(counts)
console.log('✓ views applied\n')

await close()
