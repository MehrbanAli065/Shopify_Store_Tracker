/**
 * Ingest one store's CSV for one day, diff it against the previous state,
 * and write only what changed into variant_history.
 *
 *   node scripts/ingest.mjs --store 1 --date 2026-07-27 --file "C:\path\to.csv"
 *
 * Re-running the same store+date is safe: the run is replaced.
 */
import fs from 'node:fs'
import { parse } from 'csv-parse/sync'
import { q, one, exec, close } from '../lib/db.mjs'

// ── args ──────────────────────────────────────────────────────────
const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
}
const STORE_ID = Number(args.store)
const RUN_DATE = args.date
const FILE     = args.file

if (!STORE_ID || !RUN_DATE || !FILE) {
  console.error('usage: --store <id> --date <YYYY-MM-DD> --file <path>')
  process.exit(1)
}
if (!fs.existsSync(FILE)) { console.error('file not found:', FILE); process.exit(1) }

// ── helpers ───────────────────────────────────────────────────────
const num = v => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
const s = v => (v ?? '').toString().trim()
const eqNum = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005)

/** Insert rows in chunks — PGlite is WASM, one statement per row is far too slow. */
async function bulk (table, cols, rows, { returning = null, chunk = 400 } = {}) {
  const out = []
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    const values = slice.map((_, r) =>
      '(' + cols.map((__, c) => `$${r * cols.length + c + 1}`).join(',') + ')').join(',')
    const params = slice.flat()
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${values}` +
                (returning ? ` RETURNING ${returning}` : '')
    const res = await q(sql, params)
    if (returning) out.push(...res)
  }
  return out
}

// ── 1 · parse the CSV ─────────────────────────────────────────────
console.log(`\n▸ store ${STORE_ID} · ${RUN_DATE}`)
console.log(`  file: ${FILE.split(/[\\/]/).pop()}`)

const raw = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '')
const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true })

const csvProducts = new Map()   // handle -> product fields
const csvVariants = new Map()   // handle|variant_key -> variant fields

for (const r of rows) {
  const handle = s(r['Handle'])
  if (!handle) continue

  // parent row carries the product-level fields
  if (s(r['Title'])) {
    csvProducts.set(handle, {
      handle,
      title:        s(r['Title']),
      vendor:       s(r['Vendor'])       || null,
      product_type: s(r['Type'])         || null,
      tags:         s(r['Tags']) ? s(r['Tags']).split(',').map(t => t.trim()).filter(Boolean) : [],
      published_at: s(r['Published'])    || null,
      status:       s(r['Status'])       || null,
      image_src:    s(r['Image Src'])    || null
    })
  } else if (csvProducts.has(handle) && !csvProducts.get(handle).image_src && s(r['Image Src'])) {
    csvProducts.get(handle).image_src = s(r['Image Src'])
  }

  // a variant row has a SKU or a price
  const sku   = s(r['Variant SKU'])
  const price = s(r['Variant Price'])
  if (!sku && !price) continue

  const o1 = s(r['Option1 Value']), o2 = s(r['Option2 Value']), o3 = s(r['Option3 Value'])
  const variant_key = [sku, o1, o2, o3].join('|')      // SKUs repeat — options disambiguate
  const key = handle + '\u0000' + variant_key
  if (csvVariants.has(key)) continue

  csvVariants.set(key, {
    handle, variant_key, sku: sku || null,
    option1_name: s(r['Option1 Name']) || null, option1_value: o1 || null,
    option2_name: s(r['Option2 Name']) || null, option2_value: o2 || null,
    option3_name: s(r['Option3 Name']) || null, option3_value: o3 || null,
    variant_image: s(r['Variant Image']) || null,
    price: num(price),
    compare_at: num(r['Variant Compare At Price'])
  })
}

console.log(`  parsed: ${rows.length} rows → ${csvProducts.size} products, ${csvVariants.size} variants`)

// ── 2 · open the scrape run ───────────────────────────────────────
// Re-running a date means undoing it first. That is only safe for the most
// recent run: the Layer-1 cache holds the newest state, so replaying an older
// day on top of newer data would produce nonsense diffs. Refuse that outright.
const prior = await one(
  `SELECT id FROM scrape_runs WHERE store_id = $1 AND run_date = $2`, [STORE_ID, RUN_DATE])

if (prior) {
  const newer = await q(
    `SELECT run_date FROM scrape_runs WHERE store_id = $1 AND run_date > $2 ORDER BY run_date`,
    [STORE_ID, RUN_DATE])
  if (newer.length) {
    console.error(
      `\n  ✗ ${RUN_DATE} has already been ingested, and newer runs exist ` +
      `(${newer.map(r => r.run_date).join(', ')}).\n` +
      `    Replaying an older day on top of newer data would corrupt the history.\n` +
      `    Re-ingest the newest date instead, or rebuild the store from scratch.\n`)
    await close(); process.exit(2)
  }

  console.log(`  rewinding the existing ${RUN_DATE} run …`)
  // drop this run's history, then rebuild the current-state layer from what is left
  await q(`DELETE FROM variant_history WHERE scrape_run_id = $1`, [prior.id])
  await q(`DELETE FROM scrape_runs WHERE id = $1`, [prior.id])

  await q(`
    UPDATE variants v
       SET current_price = h.price, current_compare_at_price = h.compare_at_price,
           current_in_stock = h.in_stock, is_active = h.in_stock, last_seen_at = h.observed_date
      FROM (SELECT DISTINCT ON (variant_id) variant_id, price, compare_at_price, in_stock, observed_date
              FROM variant_history ORDER BY variant_id, observed_date DESC) h
     WHERE h.variant_id = v.id
       AND v.product_id IN (SELECT id FROM products WHERE store_id = $1)`, [STORE_ID])

  // anything whose only history was in that run never existed as far as we know
  await q(`
    DELETE FROM variants v USING products p
     WHERE p.id = v.product_id AND p.store_id = $1
       AND NOT EXISTS (SELECT 1 FROM variant_history h WHERE h.variant_id = v.id)`, [STORE_ID])
  await q(`
    DELETE FROM products p
     WHERE p.store_id = $1
       AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id)`, [STORE_ID])

  await q(`
    UPDATE products p
       SET last_seen_at = agg.seen, is_active = agg.live
      FROM (SELECT product_id, MAX(last_seen_at) AS seen, BOOL_OR(is_active) AS live
              FROM variants GROUP BY product_id) agg
     WHERE agg.product_id = p.id AND p.store_id = $1`, [STORE_ID])
}
const run = await one(
  `INSERT INTO scrape_runs (store_id, run_date, status, file_name, rows_ingested, products_found, variants_found)
   VALUES ($1,$2,'pending',$3,$4,$5,$6) RETURNING id`,
  [STORE_ID, RUN_DATE, FILE.split(/[\\/]/).pop(), rows.length, csvProducts.size, csvVariants.size])
const RUN_ID = run.id

// ── 3 · load yesterday's state (Layer 1 — no history scan) ────────
const dbProducts = new Map()
for (const p of await q(
  `SELECT id, handle, first_seen_at, is_active FROM products WHERE store_id = $1`, [STORE_ID])) {
  dbProducts.set(p.handle, p)
}
const dbVariants = new Map()
for (const v of await q(
  `SELECT v.id, v.product_id, p.handle, v.variant_key,
          v.current_price, v.current_compare_at_price, v.current_in_stock, v.is_active
     FROM variants v JOIN products p ON p.id = v.product_id
    WHERE p.store_id = $1`, [STORE_ID])) {
  dbVariants.set(v.handle + '\u0000' + v.variant_key, v)
}
const isFirstRun = dbVariants.size === 0
console.log(`  previous state: ${dbProducts.size} products, ${dbVariants.size} variants` +
            (isFirstRun ? '  (first run)' : ''))

// ── 4 · SAFETY: a collapsed feed is a scrape failure, not a store event ──
let allowRemovals = true
if (!isFirstRun && csvProducts.size < dbProducts.size * 0.5) {
  allowRemovals = false
  console.log(`  ⚠ product count collapsed (${dbProducts.size} → ${csvProducts.size}) — ` +
              `skipping removal detection, run marked partial`)
}

// ── 5 · products: insert new, refresh existing ────────────────────
const newProducts = [...csvProducts.values()].filter(p => !dbProducts.has(p.handle))
if (newProducts.length) {
  const inserted = await bulk('products',
    ['store_id','handle','title','vendor','product_type','tags','published_at','status',
     'image_src','first_seen_at','last_seen_at','is_active'],
    newProducts.map(p => [STORE_ID, p.handle, p.title, p.vendor, p.product_type, p.tags,
                          p.published_at, p.status, p.image_src, RUN_DATE, RUN_DATE, true]),
    { returning: 'id, handle' })
  for (const r of inserted) dbProducts.set(r.handle, { id: r.id, handle: r.handle, first_seen_at: RUN_DATE, is_active: true })
}
const seenHandles = [...csvProducts.keys()]
if (seenHandles.length) {
  await q(`UPDATE products SET last_seen_at = $2, is_active = true
            WHERE store_id = $1 AND handle = ANY($3)`, [STORE_ID, RUN_DATE, seenHandles])
}

// ── 6 · variants: insert new, then diff the rest ──────────────────
const newVariants = [...csvVariants.entries()].filter(([k]) => !dbVariants.has(k))
if (newVariants.length) {
  const inserted = await bulk('variants',
    ['product_id','sku','option1_name','option1_value','option2_name','option2_value',
     'option3_name','option3_value','variant_image','variant_key',
     'current_price','current_compare_at_price','current_in_stock',
     'first_seen_at','last_seen_at','is_active'],   // current_discount_pct is generated
    newVariants.map(([, v]) => [
      dbProducts.get(v.handle).id, v.sku,
      v.option1_name, v.option1_value, v.option2_name, v.option2_value,
      v.option3_name, v.option3_value, v.variant_image, v.variant_key,
      v.price, v.compare_at, true, RUN_DATE, RUN_DATE, true]),
    { returning: 'id, product_id, variant_key' })

  const byPid = new Map([...dbProducts.values()].map(p => [String(p.id), p.handle]))
  for (const r of inserted) {
    dbVariants.set(byPid.get(String(r.product_id)) + '\u0000' + r.variant_key,
      { id: r.id, current_price: null, current_compare_at_price: null, current_in_stock: null, is_active: true })
  }
}

// ── 7 · THE DIFF — one history row per variant that actually changed ──
const history = []            // [variant_id, run_id, date, price, compare, in_stock, pp, pc, pis, type]
const cacheUpdates = []       // [variant_id, price, compare, in_stock]

for (const [key, v] of csvVariants) {
  const dbv = dbVariants.get(key)
  const isNew = newVariants.some(([k]) => k === key)

  if (isNew) {
    history.push([dbv.id, RUN_ID, RUN_DATE, v.price, v.compare_at, true, null, null, null, 'new'])
    continue
  }

  const priceChanged   = !eqNum(num(dbv.current_price), v.price)
  const compareChanged = !eqNum(num(dbv.current_compare_at_price), v.compare_at)
  const stockChanged   = dbv.current_in_stock !== true

  if (!priceChanged && !compareChanged && !stockChanged) continue   // nothing to record

  // one row per variant per day; priority decides the label, all values are on the row
  let type
  if (stockChanged)            type = 'stock_in'
  else if (priceChanged)       type = v.price > num(dbv.current_price) ? 'price_up' : 'price_down'
  else                         type = 'discount_change'

  history.push([dbv.id, RUN_ID, RUN_DATE, v.price, v.compare_at, true,
                num(dbv.current_price), num(dbv.current_compare_at_price), dbv.current_in_stock, type])
  cacheUpdates.push([dbv.id, v.price, v.compare_at, true])
}

// ── 8 · things that vanished from the feed ────────────────────────
let goneVariants = 0, goneProducts = 0
if (allowRemovals && !isFirstRun) {
  const missingHandles = new Set([...dbProducts.keys()].filter(h => !csvProducts.has(h)))

  for (const [key, dbv] of dbVariants) {
    if (csvVariants.has(key)) continue
    if (dbv.is_active === false && dbv.current_in_stock === false) continue   // already out
    const handle = key.split('\u0000')[0]
    const type = missingHandles.has(handle) ? 'removed' : 'stock_out'
    history.push([dbv.id, RUN_ID, RUN_DATE,
                  num(dbv.current_price), num(dbv.current_compare_at_price), false,
                  num(dbv.current_price), num(dbv.current_compare_at_price), dbv.current_in_stock, type])
    cacheUpdates.push([dbv.id, num(dbv.current_price), num(dbv.current_compare_at_price), false])
    goneVariants++
  }

  if (missingHandles.size) {
    await q(`UPDATE products SET is_active = false WHERE store_id = $1 AND handle = ANY($2)`,
            [STORE_ID, [...missingHandles]])
    goneProducts = missingHandles.size
  }
}

// ── 9 · write history, then refresh the Layer 1 cache ─────────────
if (history.length) {
  await bulk('variant_history',
    ['variant_id','scrape_run_id','observed_date','price','compare_at_price','in_stock',
     'prev_price','prev_compare_at_price','prev_in_stock','change_type'], history)
}
for (let i = 0; i < cacheUpdates.length; i += 400) {
  const slice = cacheUpdates.slice(i, i + 400)
  await q(`UPDATE variants v SET current_price = d.p, current_compare_at_price = d.c,
                                 current_in_stock = d.s, is_active = d.s
             FROM (SELECT * FROM UNNEST($1::bigint[], $2::numeric[], $3::numeric[], $4::boolean[])
                        AS t(id, p, c, s)) d
            WHERE v.id = d.id`,
    [slice.map(r => r[0]), slice.map(r => r[1]), slice.map(r => r[2]), slice.map(r => r[3])])
}
const seenKeys = [...csvVariants.keys()].map(k => k.split('\u0000')[1])
if (seenKeys.length) {
  await q(`UPDATE variants v SET last_seen_at = $2
             FROM products p
            WHERE p.id = v.product_id AND p.store_id = $1 AND v.variant_key = ANY($3)`,
          [STORE_ID, RUN_DATE, seenKeys])
}

// ── 10 · close the run ────────────────────────────────────────────
await q(`UPDATE scrape_runs SET status = $2, changes_found = $3, finished_at = now() WHERE id = $1`,
        [RUN_ID, allowRemovals ? 'success' : 'partial', history.length])
await q(`UPDATE stores SET last_scraped_at = $2 WHERE id = $1`, [STORE_ID, RUN_DATE])

// ── report ────────────────────────────────────────────────────────
const counts = {}
for (const h of history) counts[h[9]] = (counts[h[9]] || 0) + 1
console.log(`\n  ── changes recorded: ${history.length} ──`)
for (const t of ['new','price_up','price_down','discount_change','stock_in','stock_out','removed']) {
  if (counts[t]) console.log(`     ${t.padEnd(16)} ${counts[t]}`)
}
if (goneProducts) console.log(`     (products delisted: ${goneProducts})`)
const unchanged = csvVariants.size - history.filter(h => h[9] !== 'stock_out' && h[9] !== 'removed').length
console.log(`     ${'unchanged'.padEnd(16)} ${unchanged}  ← no row written`)
console.log(`\n✓ run ${RUN_ID} ${allowRemovals ? 'success' : 'PARTIAL'}\n`)

await close()
