/**
 * Ingest one store's CSV for one day, diff it against the previous state,
 * and write only what changed into variant_history.
 *
 *   node scripts/ingest.mjs --store 1 --date 2026-07-27 --file "C:\path\to.csv"
 *
 * Re-running a store's MOST RECENT date is safe — the run is rewound and
 * redone. Replaying an older date is refused; see step 2.
 */
import fs from 'node:fs'
import { parse } from 'csv-parse'
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

/** Blank = sellable, explicit 0 = sold out, a real number = that many left. */
function available (raw) {
  const t = s(raw)
  if (t === '') return true
  const n = Number(t)
  return Number.isFinite(n) ? n > 0 : true
}

/**
 * The raw Inventory quantity, or null when the store gave us nothing usable.
 * A 0 is a state marker, not a count — it tells us the variant sold out but
 * says nothing about how many were there, so it is not reported as a quantity.
 */
function qty (raw) {
  const t = s(raw)
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null
}

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

// Streamed, not read whole. The largest export here is 386 MB, which as a JS
// string is ~770 MB before the parser has built a single row, and the array of
// row objects it then built came to more again: two stores died on 2 Sep 2026
// with "heap out of memory" at Node's 2 GB ceiling, on a server with 7 GB.
// Nothing below ever looks at a row twice, so nothing needs them all at once —
// only the two maps, which are the products and the variants themselves.
const parser = fs.createReadStream(FILE).pipe(parse({
  columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true,
  bom: true   // was a .replace() on the raw string; the parser strips it in stream
}))

const csvProducts = new Map()   // handle -> product fields
const csvVariants = new Map()   // handle|variant_key -> variant fields
let rowCount = 0

for await (const r of parser) {
  rowCount++
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
      image_src:    s(r['Image Src'])    || null,
      // Added to the export on 21 Aug 2026: "Yes" on the parent row of each of
      // the store's 20 best sellers, blank everywhere else. Exports older than
      // that carry no such column, and one store's still does not, so a missing
      // column stays null rather than becoming a store-wide false.
      is_top_seller: 'Top 20 Selling Product' in r
        ? /^y/i.test(s(r['Top 20 Selling Product']))
        : null
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
    compare_at: num(r['Variant Compare At Price']),
    // Inventory quantity carries the stock signal after all: blank means the
    // variant is sellable, an explicit 0 means it has sold out. Checked against
    // the store's live /products.json feed — 99.2% agreement over 3,406 variants.
    available: available(r['Inventory quantity']),
    qty: qty(r['Inventory quantity'])
  })
}

console.log(`  parsed: ${rowCount} rows → ${csvProducts.size} products, ${csvVariants.size} variants`)

// ── 2 · open the scrape run ───────────────────────────────────────
// Re-running a date means undoing it first. That is only safe for the most
// recent run: the Layer-1 cache holds the newest state, so replaying an older
// day on top of newer data would produce nonsense diffs. Refuse that outright.
const prior = await one(
  `SELECT id FROM scrape_runs WHERE store_id = $1 AND run_date = $2`, [STORE_ID, RUN_DATE])

/**
 * What makes a replay unsafe is newer data, not a previous attempt at this one.
 *
 * The check used to sit inside `if (prior)`, so it only fired for a day that
 * had already been ingested. The dangerous case is the opposite: a day that was
 * MISSED — the store crashed, or its file never arrived — and then later days
 * went in. Filling that gap now diffs an old file against a newer state and
 * writes changes that never happened, and nothing stopped it.
 *
 * Found on 9 Sep 2026: store 3 crashed on the 7th and 8th, and the guard would
 * have let both be "filled in" on top of the 9th.
 */
const newer = await q(
  `SELECT run_date FROM scrape_runs WHERE store_id = $1 AND run_date > $2 ORDER BY run_date`,
  [STORE_ID, RUN_DATE])

if (newer.length) {
  console.error(
    `\n  ✗ ${RUN_DATE} is older than data this store already has ` +
    `(${newer.map(r => r.run_date).join(', ')}).\n` +
    `    ${prior ? 'Replaying' : 'Filling in'} an older day on top of newer data would ` +
    `record changes that never happened.\n` +
    `    Re-ingest the newest date instead, or rebuild the store from scratch.\n`)
  await close(); process.exit(2)
}

if (prior) {

  console.log(`  rewinding the existing ${RUN_DATE} run …`)
  // drop this run's history, then rebuild the current-state layer from what is left
  await q(`DELETE FROM variant_history WHERE scrape_run_id = $1`, [prior.id])
  await q(`DELETE FROM scrape_runs WHERE id = $1`, [prior.id])

  await q(`
    UPDATE variants v
       SET current_price = h.price, current_compare_at_price = h.compare_at_price,
           current_in_stock = h.in_stock, is_active = h.in_feed, last_seen_at = h.observed_date,
           current_qty = h.inventory_qty
      FROM (SELECT DISTINCT ON (variant_id) variant_id, price, compare_at_price, in_stock,
                   in_feed, inventory_qty, observed_date
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
  [STORE_ID, RUN_DATE, FILE.split(/[\\/]/).pop(), rowCount, csvProducts.size, csvVariants.size])
const RUN_ID = run.id

// ── 3 · load yesterday's state (Layer 1 — no history scan) ────────
const dbProducts = new Map()
for (const p of await q(
  `SELECT id, handle, first_seen_at, is_active FROM products WHERE store_id = $1`, [STORE_ID])) {
  dbProducts.set(p.handle, p)
}
const dbVariants = new Map()
for (const v of await q(
  // last_in_feed comes from the history, not from the cache: the cache's
  // is_active used to be set from in_stock, so it cannot answer "has this
  // variant already been recorded as gone".
  `SELECT v.id, v.product_id, p.handle, v.variant_key,
          v.current_price, v.current_compare_at_price, v.current_in_stock, v.is_active,
          h.in_feed AS last_in_feed
     FROM variants v JOIN products p ON p.id = v.product_id
     LEFT JOIN LATERAL (
       SELECT in_feed FROM variant_history
        WHERE variant_id = v.id ORDER BY observed_date DESC LIMIT 1) h ON true
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
     'image_src','is_top_seller','first_seen_at','last_seen_at','is_active'],
    newProducts.map(p => [STORE_ID, p.handle, p.title, p.vendor, p.product_type, p.tags,
                          p.published_at, p.status, p.image_src, p.is_top_seller,
                          RUN_DATE, RUN_DATE, true]),
    { returning: 'id, handle' })
  for (const r of inserted) dbProducts.set(r.handle, { id: r.id, handle: r.handle, first_seen_at: RUN_DATE, is_active: true })
}
const seenHandles = [...csvProducts.keys()]
if (seenHandles.length) {
  await q(`UPDATE products SET last_seen_at = $2, is_active = true
            WHERE store_id = $1 AND handle = ANY($3)`, [STORE_ID, RUN_DATE, seenHandles])

  // Only an export that carries the column may overwrite the flag. An unmarked
  // product in such an export is false, not null, so dropping out of the top 20
  // lands; an export without the column leaves yesterday's answer alone.
  const top = [...csvProducts.values()].filter(p => p.is_top_seller !== null)
  if (top.length) {
    await q(`UPDATE products p SET is_top_seller = c.flag
               FROM (SELECT unnest($2::text[]) AS handle, unnest($3::boolean[]) AS flag) c
              WHERE p.store_id = $1 AND p.handle = c.handle`,
            [STORE_ID, top.map(p => p.handle), top.map(p => p.is_top_seller)])

    // The flag above is overwritten every day. Keep the day itself as well, so
    // the frontend can show when a product entered or left the top 20.
    const marked = top.filter(p => p.is_top_seller).map(p => p.handle)
    if (marked.length) {
      await q(`INSERT INTO product_top_sellers (product_id, scrape_run_id, observed_date)
               SELECT p.id, $3, $4 FROM products p
                WHERE p.store_id = $1 AND p.handle = ANY($2)
               ON CONFLICT (product_id, observed_date) DO NOTHING`,
              [STORE_ID, marked, RUN_ID, RUN_DATE])
    }
  }
}

// ── 6 · variants: insert new, then diff the rest ──────────────────
const newVariants = [...csvVariants.entries()].filter(([k]) => !dbVariants.has(k))
if (newVariants.length) {
  const inserted = await bulk('variants',
    // store_id is denormalised here and on variant_history: without it every
    // store-scoped read had to join back through products, which on a large
    // store turned one archived day into a 54s query. See db/store-id.sql.
    ['store_id','product_id','sku','option1_name','option1_value','option2_name','option2_value',
     'option3_name','option3_value','variant_image','variant_key',
     'current_price','current_compare_at_price','current_in_stock','current_qty',
     'first_seen_at','last_seen_at','is_active','in_feed'],  // current_discount_pct is generated
    newVariants.map(([, v]) => [
      STORE_ID, dbProducts.get(v.handle).id, v.sku,
      v.option1_name, v.option1_value, v.option2_name, v.option2_value,
      v.option3_name, v.option3_value, v.variant_image, v.variant_key,
      v.price, v.compare_at, v.available, v.qty, RUN_DATE, RUN_DATE, v.available, true]),
    { returning: 'id, product_id, variant_key' })

  const byPid = new Map([...dbProducts.values()].map(p => [String(p.id), p.handle]))
  for (const r of inserted) {
    dbVariants.set(byPid.get(String(r.product_id)) + '\u0000' + r.variant_key,
      { id: r.id, current_price: null, current_compare_at_price: null, current_in_stock: null, is_active: true })
  }
}

// ── 7 · THE DIFF — one history row per variant that actually changed ──
const history = []            // [variant_id, run_id, date, price, compare, in_feed, in_stock, qty, pp, pc, pis, type]
const cacheUpdates = []       // [variant_id, price, compare, in_stock, qty]

for (const [key, v] of csvVariants) {
  const dbv = dbVariants.get(key)
  const isNew = newVariants.some(([k]) => k === key)

  if (isNew) {
    history.push([STORE_ID, dbv.id, RUN_ID, RUN_DATE, v.price, v.compare_at, true, v.available, v.qty, null, null, null, 'new'])
    continue
  }

  const priceChanged   = !eqNum(num(dbv.current_price), v.price)
  // A crossed-out price of "nothing" is the same fact whether the export wrote
  // it blank or wrote 0, and stores switch between the two. Comparing them raw
  // recorded a change every time that happened: 2,794 events across the
  // database say the discount changed while both discounts read 0%, and for
  // Alkaram that was every one of its 699 discount_change rows.
  const noCompare = v => v == null || v <= 0
  const compareChanged = noCompare(num(dbv.current_compare_at_price)) && noCompare(v.compare_at)
    ? false
    : !eqNum(num(dbv.current_compare_at_price), v.compare_at)
  const stockChanged   = dbv.current_in_stock !== v.available

  // Returning to the feed is a change in its own right. Judging only price and
  // stock missed a variant that left and came back unchanged: no row was
  // written, so in_feed stayed false and carry-forward kept it delisted while
  // the file plainly listed it. 205 Alkaram variants were doing this.
  const relisted = dbv.last_in_feed === false

  if (!relisted && !priceChanged && !compareChanged && !stockChanged) continue

  // one row per variant per day; priority decides the label, all values are on the row
  let type
  if (relisted)                type = 'relisted'
  else if (stockChanged)       type = v.available ? 'stock_in' : 'stock_out'
  else if (priceChanged)       type = v.price > num(dbv.current_price) ? 'price_up' : 'price_down'
  else                         type = 'discount_change'

  history.push([STORE_ID, dbv.id, RUN_ID, RUN_DATE, v.price, v.compare_at, true, v.available, v.qty,
                num(dbv.current_price), num(dbv.current_compare_at_price), dbv.current_in_stock, type])
  cacheUpdates.push([dbv.id, v.price, v.compare_at, v.available, v.qty])
}

// ── 8 · things that vanished from the feed ────────────────────────
let goneVariants = 0, goneProducts = 0
if (allowRemovals && !isFirstRun) {
  const missingHandles = new Set([...dbProducts.keys()].filter(h => !csvProducts.has(h)))

  for (const [key, dbv] of dbVariants) {
    if (csvVariants.has(key)) continue

    // Everything reaching here is absent from today's file, so it has left the
    // feed. That is a feed fact and has to be recorded even for a variant that
    // was already unsellable: skipping the row leaves in_feed true forever, and
    // carry-forward then counts a delisted variant as listed in every later
    // report. Ten Brooklinen variants were doing exactly that.
    //
    // Record the departure once, then stay quiet, or every run re-logs the same
    // removals for as long as the variant stays gone. The test is the last row's
    // in_feed, not its stock: out of stock and off the feed are different facts,
    // and only the second one belongs here.
    if (dbv.last_in_feed === false) continue

    const type = 'removed'
    history.push([STORE_ID, dbv.id, RUN_ID, RUN_DATE,
                  num(dbv.current_price), num(dbv.current_compare_at_price), false, false, null,
                  num(dbv.current_price), num(dbv.current_compare_at_price), dbv.current_in_stock, type])
    cacheUpdates.push([dbv.id, num(dbv.current_price), num(dbv.current_compare_at_price), false, null])
    goneVariants++
  }

  // only the ones that were still listed as of the previous run
  const newlyGone = [...missingHandles].filter(x => dbProducts.get(x)?.is_active !== false)
  if (newlyGone.length) {
    await q(`UPDATE products SET is_active = false WHERE store_id = $1 AND handle = ANY($2)`,
            [STORE_ID, newlyGone])
    goneProducts = newlyGone.length
  }
}

// ── 9 · write history, then refresh the Layer 1 cache ─────────────
if (history.length) {
  await bulk('variant_history',
    ['store_id','variant_id','scrape_run_id','observed_date','price','compare_at_price','in_feed','in_stock',
     'inventory_qty','prev_price','prev_compare_at_price','prev_in_stock','change_type'], history)
}
for (let i = 0; i < cacheUpdates.length; i += 400) {
  const slice = cacheUpdates.slice(i, i + 400)
  await q(`UPDATE variants v SET current_price = d.p, current_compare_at_price = d.c,
                                 current_in_stock = d.s, is_active = d.s, current_qty = d.q
             FROM (SELECT * FROM UNNEST($1::bigint[], $2::numeric[], $3::numeric[],
                                        $4::boolean[], $5::int[])
                        AS t(id, p, c, s, q)) d
            WHERE v.id = d.id`,
    [slice.map(r => r[0]), slice.map(r => r[1]), slice.map(r => r[2]),
     slice.map(r => r[3]), slice.map(r => r[4])])
}
// Matched on handle AND variant_key. Keying on variant_key alone marked every
// variant in the store that shared a SKU+options combination as seen today,
// including ones that left the feed weeks ago: 4,790 rows across 70 stores.
// last_seen_at is what says which variants were in a given day's file, so it
// has to be exact.
const seenIds = [...csvVariants.keys()].map(k => dbVariants.get(k)?.id).filter(Boolean)
for (let i = 0; i < seenIds.length; i += 20000) {
  await q(`UPDATE variants SET last_seen_at = $1, in_feed = true WHERE id = ANY($2)`,
          [RUN_DATE, seenIds.slice(i, i + 20000)])
}

// in_feed is what lets the archive answer "the newest day" without replaying
// history — see db/in-feed.sql. It has to be cleared for the ones that left,
// and only when removals were trusted this run: a collapsed feed marks the run
// partial precisely because its absences are not real.
if (allowRemovals && !isFirstRun) {
  const seen = new Set(seenIds.map(String))
  const gone = [...dbVariants.values()].map(v => v.id).filter(id => !seen.has(String(id)))
  for (let i = 0; i < gone.length; i += 20000) {
    await q(`UPDATE variants SET in_feed = false WHERE id = ANY($1) AND in_feed`,
            [gone.slice(i, i + 20000)])
  }
}

// The report page reads its per-day counts from store_day_stats rather than
// scanning history on every request; this is where they change.
await q('SELECT refresh_day_stats($1, $2)', [STORE_ID, RUN_DATE])

// ── 10 · close the run ────────────────────────────────────────────
await q(`UPDATE scrape_runs SET status = $2, changes_found = $3, finished_at = now() WHERE id = $1`,
        [RUN_ID, allowRemovals ? 'success' : 'partial', history.length])
await q(`UPDATE stores SET last_scraped_at = $2 WHERE id = $1`, [STORE_ID, RUN_DATE])

// ── report ────────────────────────────────────────────────────────
const counts = {}
const TYPE = 11   // index of change_type in the history tuple
for (const h of history) counts[h[TYPE]] = (counts[h[TYPE]] || 0) + 1
console.log(`\n  ── changes recorded: ${history.length} ──`)
for (const t of ['new','price_up','price_down','discount_change','stock_in','stock_out','removed']) {
  if (counts[t]) console.log(`     ${t.padEnd(16)} ${counts[t]}`)
}
if (goneProducts) console.log(`     (products delisted: ${goneProducts})`)
const unchanged = csvVariants.size -
  history.filter(h => h[TYPE] !== 'stock_out' && h[TYPE] !== 'removed').length
console.log(`     ${'unchanged'.padEnd(16)} ${unchanged}  ← no row written`)
console.log(`\n✓ run ${RUN_ID} ${allowRemovals ? 'success' : 'PARTIAL'}\n`)

await close()
