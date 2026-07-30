/**
 * Audit the audit.
 *
 * Three independent checks, because they can fail for different reasons:
 *
 *  A · against the ingest's own CSV counters. scrape_runs.products_found /
 *      variants_found / rows_ingested were counted straight off each CSV while
 *      it was being read, before anything was written. Matching the report to
 *      those is the closest thing to checking it against the source files.
 *
 *  B · recomputed with different SQL. The report's numbers come from spans and
 *      window functions; these use plain per-day joins. Same answer from two
 *      shapes means the shape is not the thing producing the number.
 *
 *  C · against the live storefront. products.json is ground truth for what is
 *      sellable right now, owing nothing to the CSV or the ingest.
 *
 *   node scripts/verify-audit.mjs 1
 */
import 'dotenv/config'
import { q, one, close } from '../lib/db.mjs'

const storeId = Number(process.argv[2] || 1)
const rows = []
const add = (group, name, expected, actual, note) => {
  const ok = String(expected) === String(actual)
  rows.push({ group, name, expected, actual, ok, note })
}

const store = await one(`SELECT name, domain, currency FROM stores WHERE id = $1`, [storeId])
const rep = await one(`
  SELECT id, doc_no, from_date, to_date, facts FROM audit_reports
   WHERE store_id = $1 ORDER BY generated_at DESC LIMIT 1`, [storeId])
if (!rep) { console.log('  no report stored for this store'); await close(); process.exit(0) }

const F = typeof rep.facts === 'string' ? JSON.parse(rep.facts) : rep.facts
const from = String(rep.from_date).slice(0, 10)
const to   = String(rep.to_date).slice(0, 10)
const A = [storeId, from, to]

console.log(`\n  ${store.name} · ${store.domain}`)
console.log(`  report ${rep.doc_no}   T₀ ${from} → ${to}\n`)

/* ── A · the ingest's CSV counters ────────────────────────────────── */

const runs = await q(`
  SELECT run_date, rows_ingested, products_found, variants_found
    FROM scrape_runs WHERE store_id = $1 AND run_date BETWEEN $2 AND $3
      AND status IN ('success','partial') ORDER BY run_date`, A)

const csvVariantDays = runs.reduce((s, r) => s + r.variants_found, 0)
add('A · CSV counters', 'variant-days = Σ per-day variants counted from each CSV',
  csvVariantDays, F.headline.variant_days.value,
  runs.map(r => `${String(r.run_date).slice(5, 10)}:${r.variants_found}`).join(' + '))

const maxProducts = Math.max(...runs.map(r => r.products_found))
add('A · CSV counters', 'styles ≥ the largest single-day product count',
  true, F.headline.style_count.value >= maxProducts,
  `report ${F.headline.style_count.value} vs busiest CSV day ${maxProducts}`)

const lastRun = runs[runs.length - 1]
const bandTotal = F.pricing.discount_bands.reduce((s, b) => s + b.variants, 0)
add('A · CSV counters', 'discount bands total = variants in the final CSV',
  lastRun.variants_found, bandTotal,
  `bands are computed on ${to} only`)

/* ── B · recomputed with different SQL ───────────────────────────── */

// Per-day state without spans: one lateral lookup per variant per day.
const B_DAILY = `
  dates AS (SELECT run_date FROM scrape_runs
             WHERE store_id = $1 AND run_date BETWEEN $2 AND $3
               AND status IN ('success','partial')),
  vs AS (SELECT v.id, v.product_id FROM variants v
           JOIN products p ON p.id = v.product_id WHERE p.store_id = $1),
  st AS (
    SELECT d.run_date, vs.id AS variant_id, vs.product_id, s.in_stock, s.in_feed, s.discount_pct
      FROM dates d CROSS JOIN vs
      LEFT JOIN LATERAL (
        SELECT h.in_stock, h.in_feed, h.discount_pct FROM variant_history h
         WHERE h.variant_id = vs.id AND h.observed_date <= d.run_date
         ORDER BY h.observed_date DESC LIMIT 1) s ON true
     WHERE s.in_feed
  )`

const b1 = await one(`WITH ${B_DAILY}
  SELECT count(*)::int AS variant_days,
         count(DISTINCT variant_id)::int AS variants,
         count(DISTINCT product_id)::int AS styles,
         count(*) FILTER (WHERE in_stock IS false)::int AS oos,
         count(*) FILTER (WHERE in_stock IS true)::int  AS instock
    FROM st`, A)

add('B · re-derived', 'variant-days', b1.variant_days, F.headline.variant_days.value)
add('B · re-derived', 'variants',     b1.variants,     F.headline.variant_count.value)
add('B · re-derived', 'styles',       b1.styles,       F.headline.style_count.value)
add('B · re-derived', 'variant-days out of stock', b1.oos,     F.stockout.oos_variant_days.value)
add('B · re-derived', 'variant-days in stock',     b1.instock, F.stockout.in_stock_variant_days.value)
add('B · re-derived', 'out-of-stock rate %',
  Math.round((b1.oos / (b1.oos + b1.instock)) * 1000) / 10, F.stockout.oos_rate.value)

// Price movement straight off variant_history, no view.
const b2 = await one(`
  SELECT count(*) FILTER (WHERE h.change_type = 'price_down')::int AS drops,
         count(*) FILTER (WHERE h.change_type = 'price_up')::int   AS rises,
         count(*) FILTER (WHERE h.change_type = 'removed')::int    AS removed,
         count(*) FILTER (WHERE h.change_type = 'stock_out')::int  AS went_out,
         count(*) FILTER (WHERE h.change_type = 'stock_in')::int   AS came_back,
         ROUND(MAX(ABS(ROUND((h.price - h.prev_price) / h.prev_price * 100, 2)))
               FILTER (WHERE h.change_type LIKE 'price%' AND h.prev_price > 0), 2) AS max_move
    FROM variant_history h JOIN variants v ON v.id = h.variant_id
    JOIN products p ON p.id = v.product_id
   WHERE p.store_id = $1 AND h.observed_date BETWEEN $2 AND $3`, A)

add('B · re-derived', 'price drops',   b2.drops,     F.pricing.price_drops.value)
add('B · re-derived', 'price rises',   b2.rises,     F.pricing.price_rises.value)
add('B · re-derived', 'largest move %', b2.max_move, F.pricing.max_move_pct.value)
add('B · re-derived', 'variants removed', b2.removed,  F.assortment.removed_variants.value)
add('B · re-derived', 'went out of stock', b2.went_out, F.assortment.went_out.value)
add('B · re-derived', 'came back in stock', b2.came_back, F.assortment.came_back.value)

// Broken styles, counted over every style rather than a top-N list.
const b3 = await one(`WITH ${B_DAILY},
  sz AS (SELECT v.id AS variant_id,
           COALESCE(CASE WHEN v.option1_name ILIKE 'size' THEN NULLIF(v.option1_value,'') END,
                    CASE WHEN v.option2_name ILIKE 'size' THEN NULLIF(v.option2_value,'') END,
                    CASE WHEN v.option3_name ILIKE 'size' THEN NULLIF(v.option3_value,'') END) AS size_label
           FROM variants v JOIN products p ON p.id = v.product_id WHERE p.store_id = $1),
  pd AS (SELECT st.product_id, st.run_date,
                bool_or(st.in_stock IS false) AS any_out,
                bool_or(st.in_stock IS true)  AS any_in
           FROM st JOIN sz ON sz.variant_id = st.variant_id
          WHERE sz.size_label IS NOT NULL GROUP BY 1,2),
  ps AS (SELECT product_id,
                bool_or(any_out AND any_in) AS ever,
                min(run_date) FILTER (WHERE any_out AND any_in) AS first_broken
           FROM pd GROUP BY product_id)
  SELECT count(*)::int AS sized_styles,
         count(*) FILTER (WHERE ever)::int AS broken,
         count(*) FILTER (WHERE ever AND first_broken >
           (SELECT min(run_date) FROM dates))::int AS broke_inside_window
    FROM ps`, A)

add('B · re-derived', 'sized styles', b3.sized_styles, F.headline.broken_style_pct.denominator)
add('B · re-derived', 'broken styles', b3.broken,       F.headline.broken_style_pct.numerator)
add('B · re-derived', 'styles seen breaking inside the window',
  b3.broke_inside_window, F.broken_timeline.observed_breaks.value,
  b3.broke_inside_window === F.broken_timeline.observed_breaks.value
    ? null : 'the report counts only the rows it lists, so a top-N cap understates this')

/* ── C · the live storefront ──────────────────────────────────────── */

let liveNote = null
try {
  const seen = new Map()
  for (let page = 1; page <= 12; page++) {
    const r = await fetch(`https://${store.domain}/products.json?limit=250&page=${page}`,
      { headers: { 'user-agent': 'Mozilla/5.0 tracker-audit' } })
    if (!r.ok) throw new Error(`products.json ${r.status}`)
    const { products } = await r.json()
    if (!products?.length) break
    for (const p of products)
      for (const v of p.variants || [])
        seen.set(`${p.handle}::${v.title}`, v.available)
  }

  const dbRows = await q(`
    SELECT p.handle,
           NULLIF(CONCAT_WS(' / ', NULLIF(v.option1_value,''), NULLIF(v.option2_value,''),
                                   NULLIF(v.option3_value,'')), '') AS label,
           v.current_in_stock
      FROM variants v JOIN products p ON p.id = v.product_id
     WHERE p.store_id = $1 AND v.is_active`, [storeId])

  let matched = 0, agree = 0
  for (const r of dbRows) {
    const live = seen.get(`${r.handle}::${r.label}`)
    if (live === undefined) continue
    matched++
    if (live === r.current_in_stock) agree++
  }
  const pctAgree = matched ? Math.round((agree / matched) * 1000) / 10 : null
  add('C · live storefront', 'sellable flag agrees with the live site',
    true, pctAgree !== null && pctAgree >= 95,
    `${agree}/${matched} variants agree = ${pctAgree}% (live catalogue has ${seen.size} variants)`)
  liveNote = `${matched} variants matched by handle + option label`
} catch (e) {
  add('C · live storefront', 'reachable', true, false, e.message)
}

/* ── report ───────────────────────────────────────────────────────── */

let group = null
let fails = 0
for (const r of rows) {
  if (r.group !== group) { group = r.group; console.log(`  ── ${group}`) }
  if (!r.ok) fails++
  const mark = r.ok ? 'ok  ' : 'FAIL'
  const cmp = r.ok ? String(r.actual) : `expected ${r.expected}, report says ${r.actual}`
  console.log(`   ${mark} ${r.name.padEnd(48)} ${cmp}`)
  if (r.note) console.log(`        ${r.note}`)
}
if (liveNote) console.log(`\n  ${liveNote}`)
console.log(`\n  ${rows.length - fails}/${rows.length} checks passed` +
            (fails ? `  ·  ${fails} FAILED\n` : '\n'))

await close()
