/**
 * List the scrape runs per store.
 *
 * The timeline needs this to tell two very different things apart: a day the
 * scrape ran and this variant simply did not change, versus a day no file
 * arrived at all. Printing "no change" for the second would be a lie.
 */
import 'dotenv/config'
import { q, close } from '../lib/db.mjs'

const rows = await q(`
  SELECT s.id, s.name, r.run_date, r.status, r.variants_found, r.changes_found
    FROM scrape_runs r JOIN stores s ON s.id = r.store_id
   ORDER BY s.id, r.run_date`)

let store = null
for (const r of rows) {
  if (r.id !== store) { store = r.id; console.log(`\n  [${r.id}] ${r.name}`) }
  console.log(`      ${String(r.run_date).slice(0, 10)}  ${r.status.padEnd(8)}` +
              `${String(r.variants_found).padStart(6)} variants  ` +
              `${String(r.changes_found).padStart(5)} changes`)
}
console.log()
await close()
