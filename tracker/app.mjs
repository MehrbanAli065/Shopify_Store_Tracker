/**
 * The Express application: API routes + static frontend.
 *   npm start   →  http://localhost:3000
 *
 * Routes match the documented contract, so this ports to Next.js unchanged.
 */
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { q, one } from './lib/db.mjs'
import { generateAudit } from './lib/generate-audit.mjs'
import ingestRoute from './lib/ingest-route.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const app = express()

app.use(express.static(path.join(ROOT, 'public')))

// Remote ingest trigger for n8n. Adds nothing unless INGEST_TOKEN is set, and
// never mounts on Vercel — see lib/ingest-route.mjs.
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
  const rows = await q(`
    SELECT s.id, s.name, s.domain, s.country, s.currency, s.last_scraped_at,
           (SELECT count(*) FROM products WHERE store_id = s.id AND is_active)::int AS products,
           (SELECT count(*) FROM variants v JOIN products p ON p.id = v.product_id
             WHERE p.store_id = s.id AND v.is_active)::int                          AS variants,
           (SELECT count(*) FROM scrape_runs WHERE store_id = s.id)::int             AS runs,
           r.status AS last_status, r.run_date AS last_run,
           (SELECT count(*) FROM variant_history h
              JOIN variants v ON v.id = h.variant_id
              JOIN products p ON p.id = v.product_id
             WHERE p.store_id = s.id AND h.observed_date = r.run_date
               AND h.change_type <> 'new')::int                                      AS last_changes
      FROM stores s
      LEFT JOIN LATERAL (SELECT status, run_date FROM scrape_runs
                          WHERE store_id = s.id ORDER BY run_date DESC LIMIT 1) r ON true
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
      (SELECT count(*) FROM variants v JOIN products p ON p.id = v.product_id
        WHERE p.store_id = $1 AND v.is_active)::int                          AS variants,
      COUNT(*) FILTER (WHERE change_type = 'new' AND NOT is_baseline)::int AS new_items,
      COUNT(*) FILTER (WHERE change_type = 'new' AND is_baseline)::int     AS baseline_items,
      COUNT(*) FILTER (WHERE change_type = 'price_down')::int      AS price_down,
      COUNT(*) FILTER (WHERE change_type = 'price_up')::int        AS price_up,
      COUNT(*) FILTER (WHERE change_type = 'discount_change')::int AS discount_change,
      COUNT(*) FILTER (WHERE change_type = 'stock_out')::int       AS stock_out,
      COUNT(*) FILTER (WHERE change_type = 'stock_in')::int        AS stock_in,
      COUNT(*) FILTER (WHERE change_type = 'removed')::int         AS removed,
      COUNT(*) FILTER (WHERE change_type = 'relisted')::int        AS relisted,
      COUNT(*) FILTER (WHERE NOT is_baseline)::int AS total,
      COUNT(*)::int AS total_with_baseline
    FROM v_change_report
   WHERE store_id = $1 AND observed_date BETWEEN $2 AND $3`, [id, from, to])

  const disc = await one(`
    SELECT ROUND(AVG(current_discount_pct), 2) AS avg_discount
      FROM variants v JOIN products p ON p.id = v.product_id
     WHERE p.store_id = $1 AND v.is_active AND v.current_discount_pct > 0`, [id])

  // Driven by scrape_runs, not by the change rows. Grouping the history alone
  // dropped any day the scrape ran and found nothing — the row vanished
  // instead of reading zero, which looks the same as a day that never ran.
  const daily = await q(`
    SELECT r.run_date AS observed_date, r.status,
           COUNT(h.change_type) FILTER (WHERE h.change_type = 'new' AND NOT h.is_baseline)::int AS new_items,
           COUNT(h.change_type) FILTER (WHERE h.change_type = 'new' AND h.is_baseline)::int     AS baseline_items,
           COUNT(h.change_type) FILTER (WHERE h.change_type LIKE 'price%')::int AS price,
           COUNT(h.change_type) FILTER (WHERE h.change_type = 'stock_out')::int AS stock_out,
           COUNT(h.change_type) FILTER (WHERE h.change_type = 'stock_in')::int  AS stock_in,
           COUNT(h.change_type) FILTER (WHERE h.change_type = 'removed')::int   AS removed,
           COUNT(h.change_type) FILTER (WHERE h.change_type = 'relisted')::int  AS relisted,
           COUNT(h.change_type) FILTER (WHERE NOT h.is_baseline)::int AS total
      FROM scrape_runs r
      LEFT JOIN v_change_report h
             ON h.store_id = r.store_id AND h.observed_date = r.run_date
     WHERE r.store_id = $1 AND r.run_date BETWEEN $2 AND $3
     GROUP BY r.run_date, r.status ORDER BY r.run_date`, [id, from, to])

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

  const ROW_COLS = `handle, title, sku, variant_label, product_url, image_src,
    observed_date, change_type, is_baseline,
    prev_price, price, price_diff, price_diff_pct,
    prev_compare_at_price, compare_at_price, prev_discount_pct, discount_pct,
    prev_in_stock, in_stock, inventory_qty, product_first_seen, currency`

  // Same order the grouped view uses, so paging through one date continues the
  // list rather than reshuffling it.
  const ROW_ORDER = 'abs(COALESCE(price_diff_pct, 0)) DESC, handle'

  // ?date= drills into a single day. The grouped view can only ever show a
  // slice of a busy date, and without this there is no way to reach the rest.
  if (req.query.date) {
    const off = Math.max(0, Number(req.query.offset) || 0)
    const [rows, n] = await Promise.all([
      q(`SELECT ${ROW_COLS} FROM v_change_report
          WHERE store_id = $1 AND observed_date = $2::date ${baseFilter}
            AND change_type = ANY($3)
          ORDER BY ${ROW_ORDER} LIMIT $4 OFFSET $5`,
        [id, req.query.date, types, limit, off]),
      one(`SELECT count(*)::int AS n FROM v_change_report
            WHERE store_id = $1 AND observed_date = $2::date ${baseFilter}
              AND change_type = ANY($3)`, [id, req.query.date, types])
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
  const perDate = await q(`
    SELECT r.run_date AS observed_date, count(h.change_type)::int AS n
      FROM scrape_runs r
      LEFT JOIN v_change_report h
             ON h.store_id = r.store_id AND h.observed_date = r.run_date
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
  const rows = await q(`
    SELECT ${ROW_COLS} FROM v_change_report
     WHERE store_id = $1 AND observed_date BETWEEN $2 AND $3 ${baseFilter}
       AND change_type = ANY($4)
     ORDER BY observed_date DESC, ${ROW_ORDER}
     LIMIT $5 OFFSET $6`,
    [id, from, to, types, limit, offset])

  res.json({
    from, to, total, offset, limit, shown: rows.length,
    more: offset + rows.length < total,
    // Heads each group, and fills the date picker.
    per_date: perDate.map(r => ({ date: d(r.observed_date), total: r.n })),
    rows: rows.map(r => ({ ...r, observed_date: d(r.observed_date),
                           product_first_seen: d(r.product_first_seen) }))
  })
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
        FROM variants v JOIN products p ON p.id = v.product_id
       WHERE p.store_id = $1 AND v.is_active) t
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
      FROM variants v JOIN products p ON p.id = v.product_id WHERE p.store_id = $1`, [id])

  const price = await one(`
    SELECT ROUND(MIN(current_price),0) AS min, ROUND(MAX(current_price),0) AS max,
           ROUND(AVG(current_price),0) AS avg,
           ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY current_price))::numeric, 0) AS median
      FROM variants v JOIN products p ON p.id = v.product_id
     WHERE p.store_id = $1 AND v.is_active AND v.current_price > 0`, [id])

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

  const rows = await q(`
    SELECT store_name, handle, title, sku, variant_label, observed_date, change_type,
           prev_price, price, price_diff, price_diff_pct,
           prev_compare_at_price, compare_at_price, prev_discount_pct, discount_pct,
           prev_in_stock, in_stock, inventory_qty, currency, product_url
      FROM v_change_report
     WHERE store_id = $1 AND observed_date BETWEEN $2 AND $3 ${baseFilter}
       ${types ? 'AND change_type = ANY($4)' : ''}
     ORDER BY observed_date, handle`,
    types ? [id, from, to, types] : [id, from, to])

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

/** SQL that rebuilds a day's catalogue: last state on-or-before the date, still in the feed. */
const SNAPSHOT_SQL = (search, extra = '') => `
  WITH state AS (
    SELECT DISTINCT ON (h.variant_id)
           h.variant_id, h.price, h.compare_at_price, h.discount_pct,
           h.in_feed, h.in_stock, h.inventory_qty, h.observed_date AS last_changed
      FROM variant_history h
      JOIN variants v ON v.id = h.variant_id
      JOIN products p ON p.id = v.product_id
     WHERE p.store_id = $1 AND h.observed_date <= $2
     ORDER BY h.variant_id, h.observed_date DESC
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
   WHERE s.in_feed
     ${search ? `AND (p.title ILIKE $3 OR p.handle ILIKE $3 OR v.sku ILIKE $3
                      OR COALESCE(v.option1_value,'') ILIKE $3
                      OR COALESCE(v.option2_value,'') ILIKE $3)` : ''}
   ORDER BY p.handle, v.sku ${extra}`

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
  const rows = await q(SNAPSHOT_SQL(search, `LIMIT ${limit} OFFSET ${offset}`), params)

  const tot = await one(`SELECT count(*)::int AS n, count(DISTINCT handle)::int AS p
                           FROM (${SNAPSHOT_SQL(search)}) t`, params)

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
  const rows = await q(SNAPSHOT_SQL(''), [id, date])

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
    `SELECT * FROM store_state_on($1, $2) ORDER BY handle LIMIT 500`, [req.params.id, date])
  res.json({ date, count: rows.length, rows: rows.map(r => ({ ...r, changed_on: d(r.changed_on) })) })
}))

export default app
