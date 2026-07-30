/**
 * Repair a missed departure: a variant that left the feed but was never
 * recorded as gone, so carry-forward keeps it listed on every later day.
 *
 *   node scripts/repair-feed-drift.mjs 2            # show what it would do
 *   node scripts/repair-feed-drift.mjs 2 --apply
 *
 * The set is re-derived here rather than taken from anyone's notes, and the run
 * aborts unless the evidence lines up exactly:
 *
 *   · exactly one run date may disagree, and it must be the store's most recent.
 *     "Absent from the live catalogue" only implies "absent from that day's file"
 *     while nothing has happened since; on an older date a variant could have
 *     left later, and this script would then date the departure wrongly.
 *   · the number of listed variants missing from the live catalogue must equal
 *     the drift exactly. One more, and something else is going on.
 *
 * Writes one 'removed' row per variant, attached to that date's run, so the
 * existing rewind path treats them as part of it.
 */
import 'dotenv/config'
import { q, one, close } from '../lib/db.mjs'

const storeId = Number(process.argv[2] || 0)
const APPLY = process.argv.includes('--apply')
if (!storeId) { console.log('\n  usage: node scripts/repair-feed-drift.mjs <store-id> [--apply]\n'); process.exit(1) }

const store = await one(`SELECT id, name, domain FROM stores WHERE id = $1`, [storeId])
if (!store) { console.log(`  no store ${storeId}`); await close(); process.exit(1) }
console.log(`\n  ${store.name} · ${store.domain}${APPLY ? '' : '   (dry run)'}\n`)

/* ── 1 · where does carry-forward disagree with the ingested count? ── */

const DAILY = `
  run_dates AS (SELECT run_date, id AS run_id, variants_found FROM scrape_runs
                 WHERE store_id = $1 AND status IN ('success','partial')),
  spans AS (
    SELECT h.variant_id, h.observed_date AS vf,
           LEAD(h.observed_date) OVER (PARTITION BY h.variant_id ORDER BY h.observed_date) AS vt,
           h.in_feed
      FROM variant_history h JOIN variants v ON v.id = h.variant_id
      JOIN products p ON p.id = v.product_id WHERE p.store_id = $1),
  daily AS (
    SELECT d.run_date, s.variant_id FROM run_dates d
      JOIN spans s ON d.run_date >= s.vf AND (s.vt IS NULL OR d.run_date < s.vt)
     WHERE s.in_feed)`

const recon = await q(`WITH ${DAILY}
  SELECT d.run_date, d.run_id, d.variants_found::int AS csv_variants,
         (SELECT count(*)::int FROM daily x WHERE x.run_date = d.run_date) AS carried
    FROM run_dates d ORDER BY d.run_date`, [storeId])

for (const r of recon) {
  const diff = r.carried - r.csv_variants
  console.log(`   ${String(r.run_date).slice(0, 10)}  file ${String(r.csv_variants).padStart(6)}  ` +
              `carried ${String(r.carried).padStart(6)}  ${diff === 0 ? 'ok' : (diff > 0 ? '+' : '') + diff}`)
}

const drifted = recon.filter(r => r.carried !== r.csv_variants)
if (!drifted.length) { console.log('\n  nothing to repair\n'); await close(); process.exit(0) }

const latest = recon[recon.length - 1]
if (drifted.length > 1) {
  console.log(`\n  refusing: ${drifted.length} dates disagree. This script can only date a departure`)
  console.log('  safely on the most recent run; re-ingest is the right tool for older gaps.\n')
  await close(); process.exit(1)
}
const target = drifted[0]
if (String(target.run_date) !== String(latest.run_date)) {
  console.log(`\n  refusing: the drift is on ${String(target.run_date).slice(0, 10)}, not the latest run`)
  console.log(`  (${String(latest.run_date).slice(0, 10)}). Absence from the live catalogue cannot date`)
  console.log('  a departure that old.\n')
  await close(); process.exit(1)
}
const drift = target.carried - target.csv_variants
if (drift <= 0) {
  console.log(`\n  refusing: carry-forward is ${drift} behind the file, not ahead. That is a`)
  console.log('  different fault and this repair would not address it.\n')
  await close(); process.exit(1)
}

const date = String(target.run_date).slice(0, 10)
console.log(`\n  drift to repair: ${drift} variant(s) on ${date}\n`)

/* ── 2 · which listed variants are absent from the live catalogue? ── */

const listed = await q(`WITH ${DAILY}
  SELECT d.variant_id, p.handle,
         NULLIF(CONCAT_WS(' / ', NULLIF(v.option1_value,''), NULLIF(v.option2_value,''),
                                 NULLIF(v.option3_value,'')), '') AS label,
         v.current_price, v.current_compare_at_price, v.current_in_stock
    FROM daily d JOIN variants v ON v.id = d.variant_id
    JOIN products p ON p.id = v.product_id
   WHERE d.run_date = $2::date`, [storeId, date])

const live = new Set()
for (let page = 1; page <= 20; page++) {
  const res = await fetch(`https://${store.domain}/products.json?limit=250&page=${page}`,
    { headers: { 'user-agent': 'Mozilla/5.0 tracker-repair' } })
  if (!res.ok) { console.log(`  refusing: products.json returned ${res.status}\n`); await close(); process.exit(1) }
  const { products } = await res.json()
  if (!products?.length) break
  for (const p of products) for (const v of p.variants || []) live.add(`${p.handle}::${v.title}`)
}
console.log(`  live catalogue: ${live.size} variants`)
console.log(`  listed on ${date}: ${listed.length}`)

const ghosts = listed.filter(r => !live.has(`${r.handle}::${r.label}`))
console.log(`  listed but absent from live: ${ghosts.length}\n`)

if (ghosts.length !== drift) {
  console.log(`  refusing: ${ghosts.length} variants are missing from the live catalogue but the`)
  console.log(`  drift is ${drift}. These should be the same set. Something other than a missed`)
  console.log('  departure is in play, and guessing which rows to write would be worse than\n' +
              '  leaving the data wrong.\n')
  await close(); process.exit(1)
}

for (const g of ghosts)
  console.log(`   ${g.handle}  ·  ${g.label ?? '—'}`)

if (!APPLY) {
  console.log(`\n  would write ${ghosts.length} 'removed' row(s) dated ${date}, attached to run ${target.run_id}`)
  console.log('  re-run with --apply\n')
  await close(); process.exit(0)
}

/* ── 3 · write the departures ─────────────────────────────────────── */

let written = 0
for (const g of ghosts) {
  const r = await q(`
    INSERT INTO variant_history
      (variant_id, scrape_run_id, observed_date, price, compare_at_price,
       in_feed, in_stock, inventory_qty, prev_price, prev_compare_at_price,
       prev_in_stock, change_type)
    VALUES ($1,$2,$3::date,$4,$5,false,false,NULL,$4,$5,$6,'removed')
    ON CONFLICT (variant_id, observed_date, change_type) DO NOTHING
    RETURNING id`,
    [g.variant_id, target.run_id, date,
     g.current_price, g.current_compare_at_price, g.current_in_stock])
  if (r.length) written++
}

// Same cache shape the ingest leaves behind: off the feed, not sellable, and
// last_seen_at left at the day it was last actually present.
await q(`
  UPDATE variants SET is_active = false, current_in_stock = false, current_qty = NULL
   WHERE id = ANY($1)`, [ghosts.map(g => g.variant_id)])
await q(`
  UPDATE products p SET is_active = agg.live
    FROM (SELECT product_id, BOOL_OR(is_active) AS live FROM variants GROUP BY product_id) agg
   WHERE agg.product_id = p.id AND p.store_id = $1`, [storeId])
await q(`
  UPDATE scrape_runs SET changes_found = changes_found + $2 WHERE id = $1`,
  [target.run_id, written])

console.log(`\n  wrote ${written} 'removed' row(s)`)

/* ── 4 · confirm ──────────────────────────────────────────────────── */

const after = await q(`WITH ${DAILY}
  SELECT d.run_date, d.variants_found::int AS csv_variants,
         (SELECT count(*)::int FROM daily x WHERE x.run_date = d.run_date) AS carried
    FROM run_dates d ORDER BY d.run_date`, [storeId])
console.log('\n  after:')
for (const r of after) {
  const diff = r.carried - r.csv_variants
  console.log(`   ${String(r.run_date).slice(0, 10)}  file ${String(r.csv_variants).padStart(6)}  ` +
              `carried ${String(r.carried).padStart(6)}  ${diff === 0 ? 'ok' : (diff > 0 ? '+' : '') + diff}`)
}
console.log()
await close()
