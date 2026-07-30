/**
 * Generate an audit report from the command line.
 *
 *   node scripts/audit.mjs 1
 *   node scripts/audit.mjs 1 2026-07-27 2026-07-30
 *   node scripts/audit.mjs all
 */
import 'dotenv/config'
import { q, close } from '../lib/db.mjs'
import { generateAudit } from '../lib/generate-audit.mjs'

const target = process.argv[2] || '1'
const [, , , from, to] = process.argv

const ids = target === 'all'
  ? (await q(`SELECT id FROM stores WHERE active ORDER BY id`)).map(r => Number(r.id))
  : [Number(target)]

for (const storeId of ids) {
  try {
    const r = await generateAudit({ storeId, from, to })
    console.log(
      `\n  ✓ store ${r.store_id}  ${r.doc_no}\n` +
      `    ${r.from} → ${r.to}\n` +
      `    ${r.url}\n` +
      `    ${(r.bytes / 1024).toFixed(0)} KB · ${(r.generated_ms / 1000).toFixed(1)}s · ${r.model}` +
      (r.verified ? '' : '\n    ! figures failed the numeric check — deterministic text was used'))
  } catch (e) {
    console.log(`\n  ✗ store ${storeId}: ${e.message}`)
  }
}
console.log()
await close()
