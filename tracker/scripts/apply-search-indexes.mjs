/**
 * Apply db/search-indexes.sql — the trigram indexes behind the product finder.
 * Safe on a live database: it only adds indexes, and skips them if pg_trgm
 * cannot be created. Building them over 708k products takes about a minute.
 *
 *   npm run search:init
 */
import fs from 'node:fs'
import path from 'node:path'
import { exec, q, close, describe, MODE, ROOT } from '../lib/db.mjs'

console.log(`\n  target: ${describe()}  [${MODE}]\n`)
console.log('· applying db/search-indexes.sql — this can take a minute …')
const t0 = Date.now()
await exec(fs.readFileSync(path.join(ROOT, 'db', 'search-indexes.sql'), 'utf8'))

const ext = await q(`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`)
const idx = await q(`SELECT indexname FROM pg_indexes
                      WHERE tablename = 'products' AND indexname LIKE '%trgm%' ORDER BY indexname`)

console.log(`  pg_trgm: ${ext.length ? 'installed' : 'NOT available — search falls back to a scan'}`)
console.log(`  indexes: ${idx.length ? idx.map(r => r.indexname).join(', ') : 'none'}`)
console.log(`✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)

await close()
