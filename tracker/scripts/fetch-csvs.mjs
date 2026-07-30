/**
 * Download the tracked folder's CSVs to a local directory, read-only.
 *
 * Used to audit a generated report against its source: the report's numbers come
 * from Postgres, and Postgres was filled by the ingest, so re-deriving them from
 * the original files is the only check that does not trust the ingest.
 *
 *   node scripts/fetch-csvs.mjs <target-dir>
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { listCsvFiles, downloadFile, folderId, describeAuth } from '../lib/drive.mjs'

const dir = process.argv[2] || './data/csv-audit'
fs.mkdirSync(dir, { recursive: true })

console.log(`\n  auth   ${describeAuth()}`)
console.log(`  folder ${folderId()}`)

const files = await listCsvFiles()
console.log(`  found  ${files.length} csv file(s)\n`)

for (const f of files) {
  const out = path.join(dir, f.name)
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    console.log(`  = ${f.name}  (already here)`)
    continue
  }
  const buf = await downloadFile(f.id)
  fs.writeFileSync(out, buf)
  console.log(`  ↓ ${f.name}  ${(buf.length / 1048576).toFixed(1)} MB`)
}
console.log(`\n  → ${path.resolve(dir)}\n`)
