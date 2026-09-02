/**
 * The Express application: API routes + static frontend.
 *   npm start   →  http://localhost:3000
 *
 * Routes match the documented contract, so this ports to Next.js unchanged.
 */
import express from 'express'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { q, one } from './lib/db.mjs'
import { generateAudit } from './lib/generate-audit.mjs'
import ingestRoute from './lib/ingest-route.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const app = express()

/**
 * CORS, because the pages now live on Vercel and the API here. An explicit
 * allow-list from the environment, not a wildcard: this data is not public,
 * and "*" would let any site read it out of a logged-in browser.
 */
const ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Max-Age', '86400')
    res.vary('Origin')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

/**
 * gzip for anything text-shaped. These payloads are repetitive JSON and shrink
 * by 91-96% — /api/stores goes 70 KB → 7 KB, a snapshot page 108 KB → 4 KB —
 * which is the difference between a fast connection and a slow one mattering.
 *
 * Written against zlib rather than the `compression` package: it is ~20 lines
 * for what this needs, and one less dependency to keep current.
 */
app.use((req, res, next) => {
  if (!/gzip/.test(req.headers['accept-encoding'] || '')) return next()

  const send = res.send.bind(res)
  res.send = body => {
    // Only buffer/string bodies, and only when the saving is worth the CPU.
    const buf = Buffer.isBuffer(body) ? body
              : typeof body === 'string' ? Buffer.from(body, 'utf8') : null
    if (!buf || buf.length < 1024 || res.getHeader('Content-Encoding')) return send(body)

    const type = String(res.getHeader('Content-Type') || '')
    if (!/json|text|javascript|xml|csv|svg/i.test(type)) return send(body)

    return zlib.gzip(buf, (err, gz) => {
      if (err) return send(body)
      res.setHeader('Content-Encoding', 'gzip')
      res.vary('Accept-Encoding')
      res.removeHeader('Content-Length')
      send(gz)
    })
  }
  next()
})

// Static assets carry an ETag already, so a repeat visit is a 304 either way.
// A short max-age skips even that round trip without risking a stale page:
// index.html and friends are revalidated, only the assets are held.
app.use(express.static(path.join(ROOT, 'public'), {
  etag: true,
  maxAge: '10m',
  setHeaders: (res, file) => {
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
  }
}))

// Remote ingest trigger for n8n. Adds nothing unless INGEST_TOKEN is set, and
// never mounts on Vercel — see lib/ingest-route.mjs.
/**
 * The API is reachable from the open internet now — the frontend sits on
 * Vercel and reaches this host directly — and there is no login on it. So
 * every data route demands a shared token that only the Vercel proxy holds.
 *
 * Ingest keeps its own token (the VM posts straight here), and the static
 * pages stay open because they contain nothing.
 *
 * Unset API_TOKEN and the gate disappears, which is what local dev wants.
 */
const API_TOKEN = process.env.API_TOKEN || null

app.use((req, res, next) => {
  if (!API_TOKEN) return next()
  const guarded = req.path.startsWith('/api/') || req.path.startsWith('/reports/')
  if (!guarded || req.path.startsWith('/api/ingest')) return next()
  if (req.get('x-tracker-token') === API_TOKEN) return next()
  res.status(401).json({ error: 'unauthorized' })
})

app.use(ingestRoute(ROOT))

const d = v => (v instanceof Date ? v.toISOString().slice(0, 10) : v)
const wrap = fn => (req, res) =>
  fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }) })

/** Full date range that exists for a store. */
async function range (storeId) {
  const r = await one(
    `SELECT MIN(run_date) AS from, MAX(run_date) AS to FROM scrape_runs WHERE store_id = $1`, [storeId])
  return { from: d(r?.from) || null, to: d(r?.to) || null }
}
async function bounds (req, storeId) {
  const r = await range(storeId)
  return { from: req.query.from || r.from || '1970-01-01', to: req.query.to || r.to || '2999-12-31' }
}

// ── all store cards ───────────────────────────────────────────────
app.get('/api/stores', wrap(async (_req, res) => {
  // One pass per fact, grouped by store, rather than five correlated
  // subqueries per store. The original shape was written when there were two
  // stores; at 242 stores over 2.4M variants it stopped returning at all - the
  // page sat on "loading" past sixty seconds. Same numbers, ~6s instead.
  const rows = await q(`
    WITH last_run AS (
      SELECT DISTINCT ON (store_id) store_id, status, run_date, products_found
        FROM scrape_runs ORDER BY store_id, run_date DESC
    ), runs AS (
      SELECT store_id, count(*)::int n FROM scrape_runs GROUP BY 1
    )
    -- The three counts come from store_rollup, refreshed at the end of each
    -- ingest. Computing them here read the whole 2.9 GB variants table on
    -- every page load and cost ~19s; see db/rollup.sql.
    SELECT s.id, s.name, s.domain, s.country, s.currency, s.last_scraped_at,
           COALESCE(r.products, 0)     AS products,
           COALESCE(r.variants, 0)     AS variants,
           COALESCE(r.last_changes, 0) AS last_changes,
           r.refreshed_at              AS counts_as_of,
           COALESCE(runs.n, 0) AS runs,
           lr.status AS last_status, lr.run_date AS last_run,
           -- What the file actually held. A run is marked partial when this
           -- drops below half of what is stored, and the card cannot explain
           -- that without both numbers.
           lr.products_found AS last_file_products,
           -- Which warnings this store has been dismissed for. The card needs
           -- it to know whether to keep showing one.
           COALESCE(m.kinds, '{}') AS muted
      FROM stores s
      LEFT JOIN (SELECT store_id, array_agg(kind) AS kinds
                   FROM store_alert_mutes GROUP BY store_id) m ON m.store_id = s.id
      LEFT JOIN store_rollup r ON r.store_id = s.id
      LEFT JOIN last_run lr    ON lr.store_id = s.id
      LEFT JOIN runs           ON runs.store_id = s.id
     WHERE s.active
     ORDER BY s.id`)
  res.json(rows.map(r => ({ ...r, last_scraped_at: d(r.last_scraped_at), last_run: d(r.last_run) })))
}))

// ── one store: meta + available date range ────────────────────────
app.get('/api/stores/:id', wrap(async (req, res) => {
  const store = await one(`SELECT * FROM stores WHERE id = $1`, [req.params.id])
  if (!store) return res.status(404).json({ error: 'store not found' })
  const runs = await q(
    `SELECT run_date, status, products_found, variants_found, changes_found, file_name
       FROM scrape_runs WHERE store_id = $1 ORDER BY run_date`, [req.params.id])
  res.json({
    ...store,
    last_scraped_at: d(store.last_scraped_at),
    range: await range(req.params.id),
    runs: runs.map(r => ({ ...r, run_date: d(r.run_date) }))
  })
}))

// ── KPI tiles ─────────────────────────────────────────────────────
app.get('/api/stores/:id/summary', wrap(async (req, res) => {
  const id = req.params.id
  const { from, to } = await bounds(req, id)
  const k = await one(`
    SELECT
      (SELECT count(*) FROM products WHERE store_id = $1 AND is_active)::int AS products,
      (SELECT count(*) FROM variants v
        WHERE v.store_id = $1 AND v.is_active)::int                          AS variants,
      COALESCE(SUM(new_items), 0)::int       AS new_items,
      COALESCE(SUM(baseline_items), 0)::int  AS baseline_items,
      COALESCE(SUM(price_down), 0)::int      AS price_down,
      COALESCE(SUM(price_up), 0)::int        AS price_up,
      COALESCE(SUM(discount_change), 0)::int AS discount_change,
      COALESCE(SUM(stock_out), 0)::int       AS stock_out,
      COALESCE(SUM(stock_in), 0)::int        AS stock_in,
      COALESCE(SUM(removed), 0)::int         AS removed,
      COALESCE(SUM(relisted), 0)::int        AS relisted,
      COALESCE(SUM(total), 0)::int           AS total,
      COALESCE(SUM(total + baseline_items), 0)::int AS total_with_baseline
    -- Counts come from store_day_stats, filled at the end of each ingest.
    -- Deriving them here scanned 2.9M history rows on a large store to produce
    -- eleven integers; see db/day-stats.sql.
    FROM store_day_stats
   WHERE store_id = $1 AND observed_date BETWEEN $2 AND $3`, [id, from, to])

  const disc = await one(`
    SELECT ROUND(AVG(current_discount_pct), 2) AS avg_discount
      FROM variants v
     WHERE v.store_id = $1 AND v.is_active AND v.current_discount_pct > 0`, [id])

  // Driven by scrape_runs, not by the change rows. Grouping the history alone
  // dropped any day the scrape ran and found nothing — the row vanished
  // instead of reading zero, which looks the same as a day that never ran.
  const daily = await q(`
    SELECT r.run_date AS observed_date, r.status,
           COALESCE(d.new_items, 0)      AS new_items,
           COALESCE(d.baseline_items, 0) AS baseline_items,
           COALESCE(d.price_up + d.price_down + d.discount_change, 0) AS price,
           COALESCE(d.stock_out, 0)      AS stock_out,
           COALESCE(d.stock_in, 0)       AS stock_in,
           COALESCE(d.removed, 0)        AS removed,
           COALESCE(d.relisted, 0)       AS relisted,
           COALESCE(d.total, 0)          AS total
      FROM scrape_runs r
      -- Left join, not a filter: a day the scrape ran and found nothing has no
      -- stats row and must still read zero rather than disappear.
      LEFT JOIN store_day_stats d
             ON d.store_id = r.store_id AND d.observed_date = r.run_date
     WHERE r.store_id = $1 AND r.run_date BETWEEN $2 AND $3
     ORDER BY r.run_date`, [id, from, to])

  res.json({ from, to, ...k, avg_discount: disc?.avg_discount ?? 0,
             daily: daily.map(r => ({ ...r, observed_date: d(r.observed_date) })) })
}))

// ── the report table ──────────────────────────────────────────────
app.get('/api/stores/:id/report', wrap(async (req, res) => {
  const id = req.params.id
  const { from, to } = await bounds(req, id)
  const limit = Math.min(Number(req.query.limit) || 300, 5000)

  const groups = {
    price:   ['price_up', 'price_down', 'discount_change'],
    new:     ['new'],
    stock:   ['stock_out', 'stock_in'],
    removed: ['removed'],
    relisted: ['relisted']
  }
  // What the unfiltered view means: something changed about the variant itself.
  // A relisting is a change to the feed, not to the product, and it arrives in
  // bulk when a store re-adds a range: Alkaram's 31 July was 592 relistings
  // against 173 real changes. Leaving them in buries the day's actual news, so
  // they live behind their own tab.
  const REPORTED = ['new', 'price_up', 'price_down', 'discount_change',
                    'stock_out', 'stock_in', 'removed']
  const types = groups[req.query.type] || REPORTED

  // The first ingest of a store records every variant as 'new' — that is the
  // starting inventory, not news. Keep it out unless explicitly requested.
  const baseFilter = req.query.baseline === '1' ? '' : 'AND NOT is_baseline'

  const ROW_COLS = `handle, title, sku, variant_id, variant_label, product_url, image_src,
    observed_date, change_type, is_baseline,
    prev_price, price, price_diff, price_diff_pct,
    prev_compare_at_price, compare_at_price, prev_discount_pct, discount_pct,
    prev_in_stock, in_stock, inventory_qty, product_first_seen, currency`

  // Same order the grouped view uses, so paging through one date continues the
  // list rather than reshuffling it.
  const ROW_ORDER = 'abs(COALESCE(price_diff_pct, 0)) DESC, handle'

  // ?handle= narrows the whole table to one product — what the finder beside
  // the table hands back when a product is picked. It is an equality match on
  // an indexed column, so it stays cheap on the largest stores; searching the
  // change log itself by substring is not, which is why the finder searches
  // the products table and this filter only takes its answer.
  const handle = String(req.query.handle || '').trim()
  // A variant of that product, once the variant filter names one. It is the
  // primary key of the row's variant, so it needs no product filter beside it
  // — but both are sent, and both are indexed equalities.
  const variantId = String(req.query.variant_id || '').trim()

  // Array.push returns the new length, which is exactly the placeholder number
  // the value has just taken — so a filter and its parameter cannot drift.
  const pFilter = params =>
    (handle    ? ` AND handle = $${params.push(handle)}` : '') +
    (variantId ? ` AND variant_id = $${params.push(variantId)}` : '')

  // ?date= drills into a single day. The grouped view can only ever show a
  // slice of a busy date, and without this there is no way to reach the rest.
  if (req.query.date) {
    const off = Math.max(0, Number(req.query.offset) || 0)
    const rowP = [id, req.query.date, types, limit, off]
    const cntP = [id, req.query.date, types]
    const [rows, n] = await Promise.all([
      q(`SELECT ${ROW_COLS} FROM v_change_report
          WHERE store_id = $1 AND observed_date = $2::date ${baseFilter}
            AND change_type = ANY($3) ${pFilter(rowP)}
          ORDER BY ${ROW_ORDER} LIMIT $4 OFFSET $5`, rowP),
      one(`SELECT count(*)::int AS n FROM v_change_report
            WHERE store_id = $1 AND observed_date = $2::date ${baseFilter}
              AND change_type = ANY($3) ${pFilter(cntP)}`, cntP)
    ])
    return res.json({
      date: req.query.date, offset: off, total: n.n, shown: rows.length,
      more: off + rows.length < n.n,
      rows: rows.map(r => ({ ...r, observed_date: d(r.observed_date),
                             product_first_seen: d(r.product_first_seen) }))
    })
  }

  // How many events each date holds, before any row budget is spent. One busy
  // day can hold most of the range: Alkaram's 30 Jul carries 6,838 of 7,018, so
  // a flat "newest first, LIMIT 300" never reaches the days before it and the
  // earlier dates look empty when they are not.
  // Driven by scrape_runs so a day that ran and changed nothing still appears
  // and reads zero, rather than vanishing and looking like a day never checked.
  // With a product filter the fast path below cannot answer: it counts off
  // variant_history, which knows nothing about titles or handles. Counting the
  // view instead is affordable here precisely because one product is a handful
  // of variants. Only the dates that product changed on come back, so the date
  // picker beside the table becomes a list of the days it actually moved.
  const perDate = (handle || variantId) ? await (async () => {
    const p = [id, from, to, types]
    return q(`SELECT observed_date, count(*)::int AS n FROM v_change_report
               WHERE store_id = $1 AND observed_date BETWEEN $2 AND $3 ${baseFilter}
                 AND change_type = ANY($4) ${pFilter(p)}
               GROUP BY observed_date ORDER BY observed_date DESC`, p)
  })() : await q(`
    SELECT r.run_date AS observed_date, count(h.change_type)::int AS n
      FROM scrape_runs r
      -- Counting off variant_history, not the view: v_change_report joins
      -- variants, products and stores to describe each row, and this only
      -- needs one integer per date. That join was the report's slowest part.
      LEFT JOIN (
        SELECT h.store_id, h.observed_date, h.change_type,
               (h.change_type = 'new' AND h.observed_date = fr.first_date) AS is_baseline
          FROM variant_history h
          LEFT JOIN (SELECT store_id, MIN(run_date) AS first_date FROM scrape_runs
                      WHERE status IN ('success','partial') GROUP BY store_id) fr
                 ON fr.store_id = h.store_id
         WHERE h.store_id = $1 AND h.observed_date BETWEEN $2 AND $3
      ) h ON h.store_id = r.store_id AND h.observed_date = r.run_date
            ${baseFilter.replace('AND NOT is_baseline', 'AND NOT h.is_baseline')}
            AND h.change_type = ANY($4)
     WHERE r.store_id = $1 AND r.run_date BETWEEN $2 AND $3
       AND r.status IN ('success','partial')
     GROUP BY r.run_date ORDER BY r.run_date DESC`,
    [id, from, to, types])

  const total = perDate.reduce((s, r) => s + r.n, 0)
  const offset = Math.max(0, Number(req.query.offset) || 0)

  // One page, newest first. The date headings are drawn from per_date, and the
  // date picker beside the table reaches any day directly, so a busy day no
  // longer buries the ones behind it the way a plain LIMIT used to.
  const rowParams = [id, from, to, types, limit, offset]
  const rows = await q(`
    SELECT ${ROW_COLS} FROM v_change_report
     WHERE store_id = $1 AND observed_date BETWEEN $2 AND $3 ${baseFilter}
       AND change_type = ANY($4) ${pFilter(rowParams)}
     ORDER BY observed_date DESC, ${ROW_ORDER}
     LIMIT $5 OFFSET $6`, rowParams)

  res.json({
    from, to, total, offset, limit, shown: rows.length,
    handle: handle || undefined, variant_id: variantId || undefined,
    more: offset + rows.length < total,
    // Heads each group, and fills the date picker.
    per_date: perDate.map(r => ({ date: d(r.observed_date), total: r.n })),
    rows: rows.map(r => ({ ...r, observed_date: d(r.observed_date),
                           product_first_seen: d(r.product_first_seen) }))
  })
}))

// ── the product finder ────────────────────────────────────────────
/**
 * Search a store's catalogue by product name or handle.
 *
 * It searches `products`, not the change log, and that is the whole point. A
 * substring search over the log means ILIKE across every event the store has
 * ever recorded: 16 seconds on a store holding 2.8M of them, because a term
 * like "dress" matches 18,143 of that store's 19,377 products and no index can
 * narrow a request for nearly everything. The catalogue is three orders of
 * magnitude smaller, answers in milliseconds with the trigram indexes from
 * db/search-indexes.sql, and the product picked from it then filters the log
 * by an indexed equality.
 */
app.get('/api/stores/:id/products', wrap(async (req, res) => {
  const id = req.params.id
  const term = String(req.query.q || '').trim()
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  // The filter scrolls through the whole catalogue rather than stopping at the
  // first page, so it asks for the next slice as it goes. ORDER BY title, id is
  // a total order, which is what makes an offset land where the last page ended
  // instead of repeating or skipping rows.
  const offset = Math.max(0, Number(req.query.offset) || 0)

  // No term lists the store's catalogue, so the filter beside the table opens
  // as a browsable list rather than an empty box that must be guessed at.
  // % and _ are wildcards to LIKE; a user typing them means the characters.
  const params = [id]
  const WHERE = 'p.store_id = $1' + (term
    ? ` AND (p.title ILIKE $${params.push('%' + term.replace(/[\\%_]/g, c => '\\' + c) + '%')}
             OR p.handle ILIKE $${params.length})`
    : '')

  const [rows, n] = await Promise.all([
    q(`SELECT p.id, p.handle, p.title, p.image_src, p.is_active,
              p.first_seen_at, p.last_seen_at,
              (SELECT count(*)::int FROM variants v WHERE v.product_id = p.id) AS variants
         FROM products p WHERE ${WHERE}
        -- A catalogue of near-identical listings repeats titles, so id breaks
        -- the tie and the same search comes back in the same order.
        ORDER BY p.title, p.id
        LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}`, params),
    one(`SELECT count(*)::int AS n FROM products p WHERE ${WHERE}`, params.slice(0, term ? 2 : 1))
  ])

  res.json({
    q: term, total: n.n, shown: rows.length, offset,
    more: offset + rows.length < n.n,
    products: rows.map(r => ({ ...r, first_seen_at: d(r.first_seen_at),
                                     last_seen_at:  d(r.last_seen_at) }))
  })
}))

// ── one product's variants ────────────────────────────────────────
/**
 * Fills the variant filter once a product is picked. Ordered by id, which is
 * the order the feed lists them in — a store's own sizes run 36, 37, 38, and
 * sorting the label alphabetically would put 10 before 2.
 */
app.get('/api/stores/:id/variants', wrap(async (req, res) => {
  const handle = String(req.query.handle || '').trim()
  if (!handle) return res.json({ handle: '', variants: [] })

  const rows = await q(`
    SELECT v.id AS variant_id, v.sku, v.in_feed,
           NULLIF(CONCAT_WS(' / ', NULLIF(v.option1_value,''),
                                   NULLIF(v.option2_value,''),
                                   NULLIF(v.option3_value,'')), '') AS variant_label
      FROM variants v
      JOIN products p ON p.id = v.product_id
     WHERE v.store_id = $1 AND p.handle = $2
     ORDER BY v.id`, [req.params.id, handle])

  res.json({ handle, variants: rows })
}))

// ── distribution charts (current catalogue shape) ─────────────────
app.get('/api/stores/:id/distribution', wrap(async (req, res) => {
  const id = req.params.id
  const discount = await q(`
    SELECT bucket, count(*)::int AS n FROM (
      SELECT CASE WHEN COALESCE(v.current_discount_pct,0) = 0 THEN '0%'
                  WHEN v.current_discount_pct <= 20 THEN '1-20%'
                  WHEN v.current_discount_pct <= 40 THEN '21-40%'
                  WHEN v.current_discount_pct <= 60 THEN '41-60%'
                  ELSE '61%+' END AS bucket
        FROM variants v
       WHERE v.store_id = $1 AND v.is_active) t
     GROUP BY bucket`, [id])

  const order = ['0%', '1-20%', '21-40%', '41-60%', '61%+']
  const dmap = Object.fromEntries(discount.map(r => [r.bucket, r.n]))

  const types = await q(`
    SELECT product_type AS label, count(*)::int AS n
      FROM products WHERE store_id = $1 AND is_active
        AND product_type IS NOT NULL AND product_type <> ''
     GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [id])

  const stock = await one(`
    SELECT COUNT(*) FILTER (WHERE v.current_in_stock)::int      AS in_stock,
           COUNT(*) FILTER (WHERE NOT v.current_in_stock)::int  AS out_stock
      FROM variants v WHERE v.store_id = $1`, [id])

  const price = await one(`
    SELECT ROUND(MIN(current_price),0) AS min, ROUND(MAX(current_price),0) AS max,
           ROUND(AVG(current_price),0) AS avg,
           ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY current_price))::numeric, 0) AS median
      FROM variants v
     WHERE v.store_id = $1 AND v.is_active AND v.current_price > 0`, [id])

  res.json({
    discount: order.map(b => ({ bucket: b, n: dmap[b] || 0 })),
    types, stock, price
  })
}))

// ── CSV export — same rows, flat file ─────────────────────────────
app.get('/api/stores/:id/report.csv', wrap(async (req, res) => {
  const id = req.params.id
  const { from, to } = await bounds(req, id)
  const groups = { price: ['price_up','price_down','discount_change'], new: ['new'],
                   stock: ['stock_out','stock_in'], removed: ['removed'],
                   relisted: ['relisted'] }
  // Same default as the on-screen table, so an export matches what was exported.
  const types = groups[req.query.type] ||
    ['new', 'price_up', 'price_down', 'discount_change', 'stock_out', 'stock_in', 'removed']
  const baseFilter = req.query.baseline === '1' ? '' : 'AND NOT is_baseline'
  const handle = String(req.query.handle || '').trim()

  // An export should be the table it was taken from, so it takes the product
  // filter too. Without this, narrowing to one product and hitting CSV handed
  // back the whole store without saying so.
  const variantId = String(req.query.variant_id || '').trim()
  const params = types ? [id, from, to, types] : [id, from, to]
  const pFilter = (handle    ? ` AND handle = $${params.push(handle)}` : '') +
                  (variantId ? ` AND variant_id = $${params.push(variantId)}` : '')

  const rows = await q(`
    SELECT store_name, handle, title, sku, variant_label, observed_date, change_type,
           prev_price, price, price_diff, price_diff_pct,
           prev_compare_at_price, compare_at_price, prev_discount_pct, discount_pct,
           prev_in_stock, in_stock, inventory_qty, currency, product_url
      FROM v_change_report
     WHERE store_id = $1 AND observed_date BETWEEN $2 AND $3 ${baseFilter}
       ${types ? 'AND change_type = ANY($4)' : ''} ${pFilter}
     ORDER BY observed_date, handle`, params)

  const cols = Object.keys(rows[0] ?? { note: 1 })
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(c === 'observed_date' ? d(r[c]) : r[c])).join(','))].join('\n')

  const store = await one('SELECT domain FROM stores WHERE id = $1', [id])
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition',
    `attachment; filename="${(store?.domain || 'store').replace(/\W+/g, '-')}_${from}_${to}.csv"`)
  res.send(csv)
}))

// ══════════════════════════════════════════════════════════════════
//  ARCHIVE — reconstruct what a given day's CSV contained.
//  The Drive file can be deleted; the database is the archive.
// ══════════════════════════════════════════════════════════════════

/** Every archived day for a store, with the run that produced it. */
app.get('/api/stores/:id/snapshots', wrap(async (req, res) => {
  const rows = await q(`
    SELECT r.run_date, r.status, r.file_name, r.rows_ingested,
           r.products_found, r.variants_found, r.changes_found,
           r.started_at, r.finished_at
      FROM scrape_runs r WHERE r.store_id = $1 ORDER BY r.run_date DESC`, [req.params.id])
  res.json(rows.map(r => ({ ...r, run_date: d(r.run_date) })))
}))

/** True when the date asked for is the store's most recent run, which is the
 *  one case the variant cache can answer without replaying any history. */
const isLatest = async (id, date) => {
  const r = await one('SELECT max(run_date) AS d FROM scrape_runs WHERE store_id = $1', [id])
  return !!r?.d && String(d(r.d)) === String(date)
}

/** SQL that rebuilds a day's catalogue: last state on-or-before the date, still in the feed. */
/** The state CTE has two shapes. For any past date it replays the history, an
 *  unavoidable DISTINCT ON over everything the store ever recorded. For the
 *  newest date — which is what the archive opens on, and what nearly every
 *  visit looks at — the answer is already on the variant row: in_feed and the
 *  current_* cache are exactly the state the last run left behind. That turns
 *  a 1.6M-row sort into an index scan.
 *
 *  Verified equal on the newest day, store by store, before it was switched on. */
const SNAPSHOT_SQL = (search, extra = '', latest = false) => `
  WITH state AS (
    ${latest ? `
    SELECT v.id AS variant_id, v.current_price AS price,
           v.current_compare_at_price AS compare_at_price,
           v.current_discount_pct AS discount_pct,
           v.in_feed, v.current_in_stock AS in_stock,
           v.current_qty AS inventory_qty, v.last_seen_at AS last_changed
      FROM variants v
     WHERE v.store_id = $1 AND v.in_feed AND $2::date IS NOT NULL` : `
    SELECT DISTINCT ON (h.variant_id)
           h.variant_id, h.price, h.compare_at_price, h.discount_pct,
           h.in_feed, h.in_stock, h.inventory_qty, h.observed_date AS last_changed
      FROM variant_history h
     WHERE h.store_id = $1 AND h.observed_date <= $2
     ORDER BY h.variant_id, h.observed_date DESC`}
  )
  SELECT p.handle, p.title, p.vendor, p.product_type, p.tags, p.status,
         p.published_at, p.image_src, p.first_seen_at AS product_first_seen,
         v.sku, v.variant_image, v.variant_key,
         v.option1_name, v.option1_value, v.option2_name, v.option2_value,
         v.option3_name, v.option3_value,
         NULLIF(CONCAT_WS(' / ', NULLIF(v.option1_value,''), NULLIF(v.option2_value,''),
                                 NULLIF(v.option3_value,'')), '') AS variant_label,
         s.price, s.compare_at_price, s.discount_pct, s.in_stock, s.inventory_qty, s.last_changed,
         v.first_seen_at,
         'https://' || st.domain || '/products/' || p.handle AS product_url,
         st.currency
    FROM state s
    JOIN variants v  ON v.id = s.variant_id
    JOIN products p  ON p.id = v.product_id
    JOIN stores   st ON st.id = p.store_id
   -- The store filter has to be repeated on products. Without it the planner
   -- walked every product in the database in handle order to satisfy the ORDER
   -- BY — 652k rows across all 242 stores — and then threw almost all of them
   -- away. With it, idx_products_store_handle supplies the order directly.
   WHERE s.in_feed AND p.store_id = $1
     ${search ? `AND (p.title ILIKE $3 OR p.handle ILIKE $3 OR v.sku ILIKE $3
                      OR COALESCE(v.option1_value,'') ILIKE $3
                      OR COALESCE(v.option2_value,'') ILIKE $3)` : ''}
   ORDER BY p.handle, v.sku ${extra}`

/**
 * Dismiss a warning, or bring it back.
 *
 * Scoped to one kind on purpose: a store whose feed is permanently truncated
 * still needs to raise its hand if it stops reporting altogether.
 */
app.post('/api/stores/:id/mute', wrap(async (req, res) => {
  const kind = String(req.query.kind || '')
  if (!['partial', 'stale', 'failed'].includes(kind)) {
    return res.status(400).json({ error: `unknown alert kind "${kind}"` })
  }
  await q(`INSERT INTO store_alert_mutes (store_id, kind, note)
           VALUES ($1, $2, $3)
           ON CONFLICT (store_id, kind) DO UPDATE SET note = EXCLUDED.note, muted_at = now()`,
    [req.params.id, kind, req.query.note || null])
  res.json({ store_id: Number(req.params.id), kind, muted: true })
}))

app.delete('/api/stores/:id/mute', wrap(async (req, res) => {
  await q('DELETE FROM store_alert_mutes WHERE store_id = $1 AND kind = $2',
    [req.params.id, String(req.query.kind || '')])
  res.json({ store_id: Number(req.params.id), kind: req.query.kind, muted: false })
}))

/** One archived day, paginated + searchable. */
app.get('/api/stores/:id/snapshot', wrap(async (req, res) => {
  const id = req.params.id
  const date = req.query.date || (await range(id)).to
  const search = (req.query.q || '').trim()
  const like = `%${search}%`
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  const offset = Math.max(Number(req.query.offset) || 0, 0)

  const run = await one(
    `SELECT run_date, status, file_name, rows_ingested, products_found, variants_found, changes_found
       FROM scrape_runs WHERE store_id = $1 AND run_date = $2`, [id, date])

  const params = search ? [id, date, like] : [id, date]
  const latest = await isLatest(id, date)
  const rows = await q(SNAPSHOT_SQL(search, `LIMIT ${limit} OFFSET ${offset}`, latest), params)

  // Without a search the totals are a property of the store, not of the page,
  // and both come off the variants index. Running the full snapshot just to
  // count it materialised 540k rows on the largest store for two integers.
  const tot = (latest && !search)
    ? await one(`SELECT count(*)::int AS n, count(DISTINCT product_id)::int AS p
                   FROM variants WHERE store_id = $1 AND in_feed`, [id])
    : await one(`SELECT count(*)::int AS n, count(DISTINCT handle)::int AS p
                   FROM (${SNAPSHOT_SQL(search, '', latest)}) t`, params)

  res.json({
    date, search,
    run: run ? { ...run, run_date: d(run.run_date) } : null,
    total_variants: tot.n, total_products: tot.p,
    offset, limit, shown: rows.length,
    in_stock_count: rows.filter(r => r.in_stock).length,
    rows: rows.map(r => ({ ...r, last_changed: d(r.last_changed),
                           first_seen_at: d(r.first_seen_at),
                           product_first_seen: d(r.product_first_seen),
                           published_at: d(r.published_at) }))
  })
}))

/** Download an archived day as CSV — the file that was deleted from Drive. */
app.get('/api/stores/:id/snapshot.csv', wrap(async (req, res) => {
  const id = req.params.id
  const date = req.query.date || (await range(id)).to
  const rows = await q(SNAPSHOT_SQL('', '', await isLatest(id, date)), [id, date])

  const cols = ['handle','title','vendor','product_type','tags','status','sku','variant_label',
                'option1_name','option1_value','option2_name','option2_value',
                'option3_name','option3_value','price','compare_at_price','discount_pct',
                'in_stock','inventory_qty','currency','last_changed','first_seen_at','product_first_seen',
                'image_src','variant_image','product_url']
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v)
  const csv = [cols.join(','),
    ...rows.map(r => cols.map(c => esc(c === 'last_changed' || c === 'first_seen_at' ? d(r[c]) : r[c])).join(','))
  ].join('\n')

  const st = await one('SELECT domain FROM stores WHERE id = $1', [id])
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition',
    `attachment; filename="${(st?.domain||'store').replace(/\W+/g,'_')}_snapshot_${date}.csv"`)
  res.send(csv)
}))

// ── one product's full timeline ───────────────────────────────────
app.get('/api/stores/:id/timeline', wrap(async (req, res) => {
  const rows = await q(`
    SELECT handle, title, sku, variant_label, product_url, observed_date, change_type,
           prev_price, price, price_diff, price_diff_pct,
           compare_at_price, prev_discount_pct, discount_pct,
           prev_in_stock, in_stock, variant_first_seen, last_seen_at, currency
      FROM v_change_report
     WHERE store_id = $1 AND handle = $2
     ORDER BY sku, observed_date`, [req.params.id, req.query.handle])

  // Every run for this store, so the drawer can walk the calendar day by day.
  // A day the scrape ran and found nothing is "no change"; a day with no run
  // at all is a gap in coverage. The events alone cannot tell them apart.
  const runs = await q(
    `SELECT run_date, status FROM scrape_runs WHERE store_id = $1 ORDER BY run_date`,
    [req.params.id])

  res.json({
    events: rows.map(r => ({ ...r, observed_date: d(r.observed_date),
                             variant_first_seen: d(r.variant_first_seen),
                             last_seen_at: d(r.last_seen_at) })),
    runs: runs.map(r => ({ date: d(r.run_date), status: r.status }))
  })
}))

// ── generate an audit report ──────────────────────────────────────
//  POST because it costs money and writes a row; a GET here would be
//  re-fired by every crawler and refresh.
app.post('/api/stores/:id/audit', wrap(async (req, res) => {
  const { from, to } = await bounds(req, req.params.id)
  const out = await generateAudit({ storeId: Number(req.params.id), from, to })
  res.json(out)
}))

// ── a generated report, by its link ───────────────────────────────
app.get('/reports/:id', wrap(async (req, res) => {
  const r = await one(
    `SELECT html FROM audit_reports WHERE id = $1`, [req.params.id])
  if (!r) return res.status(404).type('html').send(
    '<p style="font:15px system-ui;padding:40px">That report link is not valid.</p>')
  res.type('html').send(r.html)
}))

// ── the same report as a download rather than a page ──────────────
app.get('/reports/:id/download', wrap(async (req, res) => {
  const r = await one(
    `SELECT html, doc_no, store_id, from_date, to_date FROM audit_reports WHERE id = $1`,
    [req.params.id])
  if (!r) return res.status(404).json({ error: 'no such report' })
  const st = await one(`SELECT name FROM stores WHERE id = $1`, [r.store_id])
  // Becomes the suggested PDF filename, so it carries the store and the window.
  const name = [st?.name || 'store', 'Sales Curve Audit',
                `${d(r.from_date)} to ${d(r.to_date)}`, r.doc_no]
    .join(' · ').replace(/[\\/:*?"<>|]/g, '-')
  // The browser prints this to PDF; the page carries its own print stylesheet,
  // and auto-print fires only on this route so opening the link stays quiet.
  res.type('html').send(r.html.replace('</body>',
    `<script>
       document.title = ${JSON.stringify(name)}
       addEventListener('load', () => setTimeout(() => window.print(), 350))
     </script></body>`))
}))

// ── reports already generated for a store ─────────────────────────
app.get('/api/stores/:id/audits', wrap(async (req, res) => {
  const rows = await q(`
    SELECT id, doc_no, from_date, to_date, model, generated_at, generated_ms,
           length(html) AS bytes
      FROM audit_reports WHERE store_id = $1
     ORDER BY generated_at DESC LIMIT 25`, [req.params.id])
  res.json(rows.map(r => ({ ...r, from_date: d(r.from_date), to_date: d(r.to_date),
                            url: `/reports/${r.id}` })))
}))

// ── store state on any past date (the as-of query) ────────────────
app.get('/api/stores/:id/state', wrap(async (req, res) => {
  const date = req.query.date || (await range(req.params.id)).to
  const rows = await q(
    `SELECT * FROM store_state_on($1, $2) ORDER BY handle, variant_id LIMIT 500`, [req.params.id, date])
  res.json({ date, count: rows.length, rows: rows.map(r => ({ ...r, changed_on: d(r.changed_on) })) })
}))

export default app
