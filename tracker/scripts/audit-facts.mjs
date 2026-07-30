/**
 * Run the audit fact engine and print what resolved. No OpenAI, no writes —
 * this is the way to see which spec variables have data behind them.
 *
 *   node scripts/audit-facts.mjs 1
 *   node scripts/audit-facts.mjs 1 2026-07-27 2026-07-30
 */
import 'dotenv/config'
import { q, close } from '../lib/db.mjs'
import { buildFacts, coverageTable } from '../lib/audit.mjs'

const storeId = Number(process.argv[2] || 1)
let [, , , from, to] = process.argv

if (!from || !to) {
  const r = await q(
    `SELECT MIN(run_date) AS f, MAX(run_date) AS t FROM scrape_runs WHERE store_id = $1`, [storeId])
  from = String(r[0].f).slice(0, 10)
  to   = String(r[0].t).slice(0, 10)
}

const f = await buildFacts({ storeId, from, to })

console.log(`\n  ${f.store.name}  ·  ${f.store.domain}  ·  ${f.store.currency}`)
console.log(`  T₀ ${f.window.from} → ${f.window.to}   ${f.window.run_dates.length} observed day(s)`)
console.log(`  built in ${f.generated_ms} ms\n`)

const rows = coverageTable(f)
const by = s => rows.filter(r => r.status === s).length
console.log(`  spec variables: ${by('computed')} computed · ${by('adapted')} adapted · ${by('unavailable')} unavailable\n`)

let sec = null
for (const r of rows) {
  if (r.section !== sec) { sec = r.section; console.log(`  ── ${sec}`) }
  const mark = { computed: '+', adapted: '~', unavailable: '-' }[r.status]
  const miss = r.missing ? `   needs: ${r.missing.join(', ')}` : ''
  console.log(`    ${mark} ${r.label}${miss}`)
}

console.log('\n  ── key numbers')
console.log(`    styles                ${f.headline.style_count.value}`)
console.log(`    variants              ${f.headline.variant_count.value}`)
console.log(`    variant-days          ${f.headline.variant_days.value}`)
console.log(`    OOS variant-days      ${f.stockout.oos_variant_days.value}`)
console.log(`    in-stock variant-days ${f.stockout.in_stock_variant_days.value}`)
console.log(`    OOS rate              ${f.stockout.oos_rate.value}%`)
console.log(`    styles broken on size ${f.headline.broken_style_pct.value}% ` +
            `(${f.headline.broken_style_pct.numerator}/${f.headline.broken_style_pct.denominator})`)
console.log(`    core sizes            ${f.size_curve.core_sizes.value.join(', ')}`)
console.log(`    price drops / rises   ${f.pricing.price_drops.value} / ${f.pricing.price_rises.value}`)
console.log(`    avg move              ${f.pricing.avg_move_pct.value}%  (max ${f.pricing.max_move_pct.value}%)`)

console.log('\n  ── size curve')
for (const r of f.size_curve.size_mix.rows.slice(0, 10))
  console.log(`    ${String(r.size).padEnd(16)} ${String(r.variants).padStart(5)} variants  ` +
              `${String(r.share).padStart(5)}% of range   ${String(r.oos_rate).padStart(5)}% of days OOS`)

console.log('\n  ── broken styles  (' +
            f.broken_timeline.observed_breaks.value + ' seen breaking inside the window)')
for (const r of f.broken_timeline.rows.slice(0, 8))
  console.log(`    ${String(r.handle).slice(0, 40).padEnd(42)} ` +
              `${r.at_baseline ? 'already broken  ' : 'broke ' + r.first_broken_on}  ` +
              `${r.days_broken}/${r.days_observed} days   missing: ${r.sizes_missing.join(',') || '—'}`)

console.log('\n  ── sanity checks')
for (const c of f.sanity_checks)
  console.log(`    rule ${c.rule}  ${c.skipped ? 'skipped — ' + c.skipped : (c.pass ? 'PASS' : 'FAIL') + ' — ' + c.detail}`)

console.log('\n  ── edge cases')
for (const e of f.edge_cases) console.log(`    ${e.applies ? '!' : ' '} ${e.case}: ${e.finding}`)

console.log(`\n  coverage: ${f.confidence.coverage.observed_days}/${f.confidence.coverage.window_days} days ` +
            `= ${f.confidence.coverage.completeness}%  grade ${f.confidence.coverage.grade}\n`)

await close()
