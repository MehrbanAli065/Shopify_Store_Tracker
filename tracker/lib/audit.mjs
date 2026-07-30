/**
 * Sales Curve Audit — the fact engine.
 *
 * Implements db/../template/sales-curve-audit-formulas.md against this
 * tracker's data. Section numbers, variable names and window symbols below are
 * the spec's, so a number in the report can be traced back to a named formula.
 *
 * The spec assumes a merchant reading their own store: it draws on orders,
 * returns, ad spend, waitlist signups and purchase orders. This tracker reads a
 * daily CSV of somebody else's catalogue — price, compare-at, availability and
 * assortment, nothing more. So each variable resolves to one of:
 *
 *   status 'computed'      — the spec's formula ran on real rows
 *   status 'adapted'       — same question, an input the spec assumes is
 *                            missing, so a stated substitute was used
 *   status 'unavailable'   — cannot be computed; names the missing source
 *
 * Nothing is estimated to fill a gap. A number that cannot be derived is
 * absent, not guessed — the whole point of the audit is that a planner can act
 * on it.
 */
import { q, one } from './db.mjs'

/* ── fact constructors ───────────────────────────────────────────── */

const fact = (status, o) => ({ status, ...o })
const computed    = o => fact('computed', o)
const adapted     = o => fact('adapted', o)
const unavailable = o => fact('unavailable', o)

const num = v => (v == null ? null : Number(v))
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null)

/* ── §1 · standard time periods ──────────────────────────────────── */

/**
 * The spec fixes T₀ at 90 days. Here it is whatever the store has actually
 * been observed for — anything else would claim coverage that does not exist.
 */
function resolvePeriods (runDates, from, to) {
  const days = runDates.length
  const spanDays = days
    ? Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1
    : 0
  const wStart = runDates.length
    ? runDates[Math.max(0, runDates.length - 28)]
    : null

  return {
    T0: computed({
      symbol: 'T₀', label: 'Analysis window',
      value: `${from} → ${to}`, days: spanDays, observed_days: days,
      spec: '90 days', formula: 'min(run_date) … max(run_date) for the store',
      note: spanDays < 90
        ? `the spec's 90-day window is not yet available — this store has ${days} observed day(s)`
        : null
    }),
    T_w: computed({
      symbol: 'T_w', label: 'Current velocity window',
      value: wStart ? `${wStart} → ${to}` : null,
      spec: 'trailing 28 days',
      formula: 'trailing 28 observed days inside T₀, clamped to what exists'
    }),
    T_f: unavailable({
      symbol: 'T_f', label: 'Forward projection window', spec: '90 days',
      missing: ['orders'],
      why: 'a projection needs a rate of sale; the feed carries no units sold'
    }),
    T_s: unavailable({
      symbol: 'T_s', label: 'Fashion season', spec: '14 weeks',
      missing: ['season calendar'],
      why: 'the season start is a merchant input, unknowable from a public feed'
    }),
    T_l: unavailable({
      symbol: 'T_l', label: 'Lead time', spec: 'per-SKU, per-supplier',
      missing: ['purchase orders'], why: 'no supplier or PO data in a public feed'
    }),
    T_r: unavailable({
      symbol: 'T_r', label: 'Returns recognition', spec: '30 days post-sale',
      missing: ['returns'], why: 'returns are private to the merchant'
    }),
    T_bis: unavailable({
      symbol: 'T_bis', label: 'Waitlist signal window', spec: 'rolling 60 days',
      missing: ['Klaviyo'], why: 'back-in-stock signups are private to the merchant'
    }),
    T_age: computed({
      symbol: 'T_age', label: 'Age buckets', spec: '30 / 60 / 90 / 120 days in stock',
      formula: 'days since variants.first_seen_at',
      note: spanDays < 30
        ? 'every variant is younger than the first bucket — tracking started too recently to age them'
        : null
    })
  }
}

/* ── §2 · data inputs ────────────────────────────────────────────── */

const DATA_SOURCES = [
  { source: 'Shopify Admin',        connected: 'partial',
    have: 'catalogue, variants, price, compare-at — via the daily product CSV',
    missing: 'Order, Fulfillment, Refund' },
  { source: 'Shopify Inventory',    connected: 'partial',
    have: 'sellable / not-sellable per variant per day',
    missing: 'unit counts and per-location levels' },
  { source: 'Stocky / Inv. Planner', connected: 'no', missing: 'open POs, receipt dates, lead-time history' },
  { source: 'Loop Returns',         connected: 'no', missing: 'return rates by SKU and by size' },
  { source: 'Klaviyo',              connected: 'no', missing: 'back-in-stock lists' },
  { source: 'Meta Ads',             connected: 'no', missing: 'spend, clicks, conversions' },
  { source: 'Google Ads / MC',      connected: 'no', missing: 'spend per product, feed status' },
  { source: 'GA4 / Shopify analytics', connected: 'no', missing: 'sessions, PDP views, add-to-cart' }
]

/* ── SQL building blocks ─────────────────────────────────────────── */

/**
 * Daily carry-forward state, built from history spans rather than one lookup
 * per variant per day: each history row is valid until the next one for that
 * variant, so the work is proportional to changes, not to variants × days.
 */
const DAILY = `
  run_dates AS (
    SELECT run_date FROM scrape_runs
     WHERE store_id = $1 AND run_date BETWEEN $2 AND $3
       AND status IN ('success','partial')
  ),
  spans AS (
    SELECT h.variant_id, v.product_id,
           h.observed_date AS valid_from,
           LEAD(h.observed_date) OVER (PARTITION BY h.variant_id
                                       ORDER BY h.observed_date) AS valid_to,
           h.in_stock, h.in_feed, h.price, h.discount_pct
      FROM variant_history h
      JOIN variants v ON v.id = h.variant_id
      JOIN products p ON p.id = v.product_id
     WHERE p.store_id = $1
  ),
  daily AS (
    SELECT d.run_date, s.variant_id, s.product_id,
           s.in_stock, s.in_feed, s.price, s.discount_pct
      FROM run_dates d
      JOIN spans s ON d.run_date >= s.valid_from
                  AND (s.valid_to IS NULL OR d.run_date < s.valid_to)
     WHERE s.in_feed
  )`

/**
 * §3 — the size option, found by name. Its position is not stable: one store
 * carries Size as option 1, another as option 2 behind Color, and reading by
 * position silently mixes colours and fabrics into the size curve.
 */
const SIZES = `
  sized AS (
    SELECT v.id AS variant_id,
           COALESCE(
             CASE WHEN v.option1_name ILIKE 'size' THEN NULLIF(v.option1_value,'') END,
             CASE WHEN v.option2_name ILIKE 'size' THEN NULLIF(v.option2_value,'') END,
             CASE WHEN v.option3_name ILIKE 'size' THEN NULLIF(v.option3_value,'') END
           ) AS size_label
      FROM variants v JOIN products p ON p.id = v.product_id
     WHERE p.store_id = $1
  )`

/* ── the engine ──────────────────────────────────────────────────── */

export async function buildFacts ({ storeId, from, to }) {
  const t0 = Date.now()
  const store = await one(
    `SELECT id, name, domain, currency FROM stores WHERE id = $1`, [storeId])
  if (!store) throw new Error(`store ${storeId} not found`)

  const runs = await q(
    `SELECT run_date, status FROM scrape_runs
      WHERE store_id = $1 AND run_date BETWEEN $2 AND $3
        AND status IN ('success','partial')
      ORDER BY run_date`, [storeId, from, to])
  const runDates = runs.map(r => String(r.run_date).slice(0, 10))
  if (!runDates.length) throw new Error(`no successful scrape runs for store ${storeId} in ${from}…${to}`)

  const A = [storeId, from, to]
  const periods = resolvePeriods(runDates, from, to)

  /* §4.1 — counts */
  const counts = await one(`
    WITH ${DAILY}
    SELECT count(DISTINCT product_id)::int AS style_count,
           count(DISTINCT variant_id)::int AS variant_count,
           count(*)::int                   AS variant_days
      FROM daily`, A)

  /* §4.4 — OOS days. The spec's own formula, and the one number here that
     needs no substitution. */
  const oos = await one(`
    WITH ${DAILY}
    SELECT count(*) FILTER (WHERE in_stock IS false)::int AS oos_variant_days,
           count(*) FILTER (WHERE in_stock IS true)::int  AS in_stock_variant_days,
           count(*) FILTER (WHERE in_stock IS NULL)::int  AS unknown_variant_days
      FROM daily`, A)

  /* §4.3 — the size curve. Sell-through by size needs orders; what the feed
     does show is how the assortment is spread across sizes and which sizes run
     out. A size that empties while its siblings hold stock is the demand
     signal the spec reads out of sales. */
  const sizeCurve = await q(`
    WITH ${DAILY}, ${SIZES}
    SELECT z.size_label,
           count(DISTINCT d.variant_id)::int                    AS variants,
           count(*)::int                                        AS variant_days,
           count(*) FILTER (WHERE d.in_stock IS false)::int      AS oos_days
      FROM daily d JOIN sized z ON z.variant_id = d.variant_id
     WHERE z.size_label IS NOT NULL
     GROUP BY z.size_label
     ORDER BY variants DESC`, A)

  const sizedVariants = sizeCurve.reduce((s, r) => s + r.variants, 0)
  const coreSizes = sizeCurve.slice(0, 3).map(r => r.size_label)

  /* §4.1 / §4.5 — broken size. The spec's definition minus "and selling":
     one size unavailable while a sibling size of the same style is in stock. */
  const broken = await q(`
    WITH ${DAILY}, ${SIZES},
    per_day AS (
      SELECT d.product_id, d.run_date,
             bool_or(d.in_stock IS false) AS any_out,
             bool_or(d.in_stock IS true)  AS any_in
        FROM daily d JOIN sized z ON z.variant_id = d.variant_id
       WHERE z.size_label IS NOT NULL
       GROUP BY d.product_id, d.run_date
    ),
    missing AS (
      SELECT d.product_id, z.size_label
        FROM daily d JOIN sized z ON z.variant_id = d.variant_id
       WHERE z.size_label IS NOT NULL AND d.in_stock IS false
         AND d.run_date = (SELECT max(run_date) FROM run_dates)
       GROUP BY 1, 2
    )
    SELECT p.handle, p.title, p.product_type,
           min(pd.run_date) FILTER (WHERE pd.any_out AND pd.any_in) AS first_broken_on,
           count(*) FILTER (WHERE pd.any_out AND pd.any_in)::int    AS days_broken,
           count(*)::int                                            AS days_observed,
           -- a style already broken on the first observed day did not break
           -- then; we simply arrived after it happened
           (min(pd.run_date) FILTER (WHERE pd.any_out AND pd.any_in)
              = (SELECT min(run_date) FROM run_dates))              AS at_baseline,
           (SELECT array_agg(m.size_label ORDER BY m.size_label)
              FROM missing m WHERE m.product_id = pd.product_id)    AS sizes_missing
      FROM per_day pd JOIN products p ON p.id = pd.product_id
     GROUP BY p.handle, p.title, p.product_type, pd.product_id
    HAVING count(*) FILTER (WHERE pd.any_out AND pd.any_in) > 0
     -- styles seen breaking inside the window first: those are the only ones
     -- with an observed break date, which is what the spec asks for
     ORDER BY (min(pd.run_date) FILTER (WHERE pd.any_out AND pd.any_in)
                 = (SELECT min(run_date) FROM run_dates)) ASC,
              days_broken DESC, first_broken_on
     LIMIT 12`, A)

  const brokenTotals = await one(`
    WITH ${DAILY}, ${SIZES},
    per_day AS (
      SELECT d.product_id, d.run_date,
             bool_or(d.in_stock IS false) AS any_out,
             bool_or(d.in_stock IS true)  AS any_in
        FROM daily d JOIN sized z ON z.variant_id = d.variant_id
       WHERE z.size_label IS NOT NULL
       GROUP BY d.product_id, d.run_date
    ),
    per_style AS (
      SELECT product_id,
             bool_or(any_out AND any_in) AS ever_broken,
             min(run_date) FILTER (WHERE any_out AND any_in) AS first_broken
        FROM per_day GROUP BY product_id
    )
    SELECT count(*)::int AS sized_styles,
           count(*) FILTER (WHERE ever_broken)::int AS broken_styles,
           -- counted over every style, not over the handful the timeline lists:
           -- deriving it from a top-N list understates it by the size of the cap
           count(*) FILTER (WHERE ever_broken AND first_broken >
             (SELECT min(run_date) FROM run_dates))::int AS broke_inside_window
      FROM per_style`, A)

  /* Which sizes break first, across the store. */
  const breakOrder = await q(`
    WITH ${DAILY}, ${SIZES}
    SELECT z.size_label,
           count(DISTINCT d.variant_id) FILTER (WHERE d.in_stock IS false)::int AS variants_out,
           count(DISTINCT d.variant_id)::int AS variants
      FROM daily d JOIN sized z ON z.variant_id = d.variant_id
     WHERE z.size_label IS NOT NULL
     GROUP BY z.size_label
    HAVING count(DISTINCT d.variant_id) >= 5
     ORDER BY (count(DISTINCT d.variant_id) FILTER (WHERE d.in_stock IS false))::numeric
              / count(DISTINCT d.variant_id) DESC
     LIMIT 8`, A)

  /* Pricing and discount — outside the spec, because the spec's reader owns the
     store and already knows its own prices. It is the strongest signal a
     competitor feed carries, so it is reported rather than dropped. */
  const priceMoves = await one(`
    SELECT count(*) FILTER (WHERE change_type = 'price_down')::int AS drops,
           count(*) FILTER (WHERE change_type = 'price_up')::int   AS rises,
           count(*) FILTER (WHERE change_type = 'discount_change')::int AS discount_moves,
           ROUND(AVG(ABS(price_diff_pct)) FILTER (WHERE change_type LIKE 'price%'), 2) AS avg_move_pct,
           ROUND(MAX(ABS(price_diff_pct)) FILTER (WHERE change_type LIKE 'price%'), 2) AS max_move_pct
      FROM v_change_report
     WHERE store_id = $1 AND observed_date BETWEEN $2 AND $3 AND NOT is_baseline`, A)

  const biggestDrops = await q(`
    SELECT title, variant_label, sku, prev_price, price, price_diff, price_diff_pct,
           discount_pct, observed_date, handle
      FROM v_change_report
     WHERE store_id = $1 AND observed_date BETWEEN $2 AND $3
       AND change_type = 'price_down' AND NOT is_baseline
     ORDER BY price_diff_pct ASC
     LIMIT 10`, A)

  const discountBands = await q(`
    WITH ${DAILY}
    SELECT CASE WHEN discount_pct IS NULL OR discount_pct = 0 THEN '0%'
                WHEN discount_pct <= 20 THEN '1–20%'
                WHEN discount_pct <= 40 THEN '21–40%'
                WHEN discount_pct <= 60 THEN '41–60%'
                ELSE '61%+' END AS band,
           count(DISTINCT variant_id)::int AS variants
      FROM daily
     WHERE run_date = (SELECT max(run_date) FROM run_dates)
     GROUP BY band
     ORDER BY min(COALESCE(discount_pct, 0))`, A)

  const assortment = await one(`
    SELECT count(*) FILTER (WHERE change_type = 'new' AND NOT is_baseline)::int AS new_variants,
           count(*) FILTER (WHERE change_type = 'removed')::int                AS removed_variants,
           count(*) FILTER (WHERE change_type = 'stock_out')::int              AS went_out,
           count(*) FILTER (WHERE change_type = 'stock_in')::int               AS came_back
      FROM v_change_report
     WHERE store_id = $1 AND observed_date BETWEEN $2 AND $3`, A)

  const categories = await q(`
    WITH ${DAILY}
    SELECT COALESCE(NULLIF(p.product_type,''), 'Uncategorised') AS product_type,
           count(DISTINCT d.product_id)::int AS styles,
           count(DISTINCT d.variant_id)::int AS variants,
           count(*) FILTER (WHERE d.in_stock IS false)::int AS oos_days,
           count(*)::int AS variant_days,
           ROUND(AVG(d.price), 0) AS avg_price,
           ROUND(AVG(NULLIF(d.discount_pct, 0)), 1) AS avg_discount
      FROM daily d JOIN products p ON p.id = d.product_id
     GROUP BY 1 ORDER BY variants DESC LIMIT 10`, A)

  const priceSpread = await one(`
    WITH ${DAILY}
    SELECT MIN(price) AS min_price, MAX(price) AS max_price,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)::numeric, 0) AS median_price
      FROM daily WHERE run_date = (SELECT max(run_date) FROM run_dates) AND price > 0`, A)

  /* §7 — edge cases, reported as measured rather than assumed. */
  const edges = await one(`
    SELECT (SELECT max(c) FROM (SELECT count(*) AS c FROM variants v
              JOIN products p ON p.id = v.product_id
             WHERE p.store_id = $1 GROUP BY v.product_id) t)::int AS max_variants_per_style,
           (SELECT count(*) FROM variants v JOIN products p ON p.id = v.product_id
             WHERE p.store_id = $1 AND v.first_seen_at > $2)::int AS cold_start_variants,
           (SELECT count(*) FROM variant_history h JOIN variants v ON v.id = h.variant_id
              JOIN products p ON p.id = v.product_id
             WHERE p.store_id = $1 AND h.inventory_qty IS NOT NULL)::int AS rows_with_qty`,
    [storeId, from])

  /* Feed reconciliation — not in the spec, because the spec's reader owns the
     feed and cannot drift from it. Here the carry-forward state and the count
     the ingest took off each CSV are two separate things, and they must agree:
     if a departure is ever missed, carry-forward keeps the variant listed on
     every later day and nothing downstream notices. */
  const recon = await q(`
    WITH ${DAILY}
    SELECT r.run_date, r.variants_found::int AS csv_variants,
           count(d.variant_id)::int AS carried_forward
      FROM scrape_runs r
      LEFT JOIN daily d ON d.run_date = r.run_date
     WHERE r.store_id = $1 AND r.run_date BETWEEN $2 AND $3
       AND r.status IN ('success','partial')
     GROUP BY r.run_date, r.variants_found ORDER BY r.run_date`, A)

  const drift = recon.filter(r => r.carried_forward !== r.csv_variants)

  /* §6 — the spec's sanity checks, run on the ones whose inputs exist. */
  const observedDays = counts.variant_days
  const continuity = oos.oos_variant_days + oos.in_stock_variant_days + oos.unknown_variant_days
  const checks = [
    { rule: 4, name: 'Variant-day continuity',
      detail: `in-stock ${oos.in_stock_variant_days} + OOS ${oos.oos_variant_days} + unknown ${oos.unknown_variant_days} = ${continuity} vs ${observedDays} observed variant-days`,
      pass: continuity === observedDays },
    { rule: 8, name: 'Feed reconciliation', added: true,
      detail: drift.length
        ? drift.map(r => `${String(r.run_date).slice(0, 10)}: carried ${r.carried_forward} vs ` +
            `${r.csv_variants} in the file (${r.carried_forward - r.csv_variants > 0 ? '+' : ''}` +
            `${r.carried_forward - r.csv_variants})`).join(' · ')
        : `carry-forward matches the ingested variant count on all ${recon.length} run date(s)`,
      pass: drift.length === 0 },
    { rule: 6, name: 'Ad attribution sanity', skipped: 'no ad data' },
    { rule: 1, name: 'Sum-check on total opportunity', skipped: 'no monetary components to sum' },
    { rule: 2, name: 'Sign-check on revenue delta', skipped: 'no revenue projection' },
    { rule: 3, name: 'Capture-rate ceiling', skipped: 'no plays to capture' },
    { rule: 5, name: 'Returns lag', skipped: 'no returns data' },
    { rule: 7, name: 'Confidence floor', skipped: 'no reorder candidates to grade' }
  ]

  /* Coverage grade — deliberately NOT the spec's §5 confidence interval, which
     needs the variance of velocity, lead time, AUR and returns. This grades how
     much of the window was actually observed, which is a different claim. */
  const coverage = {
    observed_days: runDates.length,
    window_days: periods.T0.days,
    completeness: pct(runDates.length, periods.T0.days),
    grade: runDates.length >= 60 ? 'High' : runDates.length >= 21 ? 'Medium' : 'Low',
    basis: 'share of the window with a successful scrape; not a statistical interval'
  }

  return {
    store: { id: store.id, name: store.name, domain: store.domain, currency: store.currency },
    window: { from, to, run_dates: runDates },
    generated_ms: Date.now() - t0,

    periods,
    data_sources: DATA_SOURCES,

    /* ── §4.1 The headline ── */
    headline: {
      style_count: computed({
        label: 'Styles read', value: counts.style_count,
        formula: 'count(distinct product_id present in the feed during T₀)',
        period: 'T₀', spec_formula: 'count(distinct product_id where order_count_T0 > 0)',
        note: 'the spec qualifies on having sold; presence in the feed is the available equivalent'
      }),
      variant_count: computed({
        label: 'Variants analysed', value: counts.variant_count,
        formula: 'count(distinct variant present in the feed during T₀)',
        period: 'T₀',
        note: 'single location, so the spec\'s (product, variant, location) tuple collapses to (product, variant)'
      }),
      variant_days: computed({
        label: 'Variant-days observed', value: counts.variant_days,
        formula: 'Σ over run dates of variants present that day', period: 'T₀'
      }),
      net_str_reported: unavailable({
        label: 'Net sell-through', spec_formula:
          '(units_sold_T0 − units_returned_within_T_r) ÷ (opening_inventory_T0 + units_received_T0)',
        missing: ['orders', 'returns', 'inventory receipts'],
        why: 'none of the three inputs exist in a public product feed'
      }),
      target_str: unavailable({
        label: 'Target STR', missing: ['merchant input'],
        why: 'a target is the merchant\'s own plan, not observable from outside'
      }),
      broken_style_pct: adapted({
        label: 'Styles broken on size', value: pct(brokenTotals.broken_styles, brokenTotals.sized_styles),
        numerator: brokenTotals.broken_styles, denominator: brokenTotals.sized_styles,
        formula: 'styles where one size was unavailable while a sibling size was in stock ÷ styles carrying a size option',
        spec_formula: 'bestsellers where a core size hit OOS by week 8 ÷ bestsellers',
        period: 'T₀',
        substituted: 'the spec restricts to top-decile bestsellers and to week 8 of the season; ' +
                     'ranking by sales is impossible here, so all sized styles are counted over the whole window'
      })
    },

    /* ── §4.2 The opportunity stack ── */
    opportunity_stack: {
      total_opportunity: unavailable({
        label: 'Total opportunity',
        spec_formula: 'broken_size + markdown_avoidance + wasted_ad_recapture + reorder_chase_lift',
        missing: ['orders', 'margin', 'ad spend', 'purchase orders'],
        why: 'every component is a currency amount derived from sales the feed does not carry'
      }),
      broken_size_opportunity: unavailable({
        label: 'Broken size opportunity',
        spec_formula: 'Σ (avg_velocity_pre_OOS × OOS_days × AUR)',
        missing: ['orders'],
        why: 'velocity and AUR both come from order lines; OOS_days is available, the other two are not',
        have: 'the OOS-days half of the formula is computed in §4.4 and §4.5'
      }),
      markdown_avoidance: unavailable({
        label: 'Markdown avoidance',
        spec_formula: 'Σ (on_hand × AUR × d_terminal × (1−v_terminal)) − (… d_now …)',
        missing: ['unit counts', 'margin', 'elasticity'],
        why: 'the Inventory quantity column is empty on every row of this feed, so on_hand is unknown'
      }),
      wasted_ad_spend: unavailable({
        label: 'Wasted ad spend',
        spec_formula: 'Σ ad_dollars × OOS_size_share',
        missing: ['Meta Ads', 'Google Ads'],
        why: 'somebody else\'s ad accounts are not observable'
      }),
      reorder_chase_lift: unavailable({
        label: 'Reorder chase lift',
        spec_formula: 'Σ chase_units × projected_STR × (AUR × GM% − airfreight)',
        missing: ['purchase orders', 'lead times', 'margin'],
        why: 'supplier terms are private'
      })
    },

    /* ── §4.3 Buy curve vs sell curve ── */
    size_curve: {
      planned_pack: unavailable({
        label: 'Planned pack ratio',
        spec_formula: 'units_ordered[size] ÷ Σ units_ordered',
        missing: ['purchase orders'], why: 'no PO history for a store you do not own'
      }),
      actual_str_by_size: unavailable({
        label: 'Actual sell-through by size',
        spec_formula: 'net_units_sold[size] ÷ Σ net_units_sold[size]',
        missing: ['orders'], why: 'no units sold'
      }),
      size_mix: adapted({
        label: 'Assortment by size', unit: '% of variants',
        rows: sizeCurve.map(r => ({
          size: r.size_label, variants: r.variants,
          share: pct(r.variants, sizedVariants),
          oos_rate: pct(r.oos_days, r.variant_days)
        })),
        formula: 'variants[size] ÷ Σ variants[size], and OOS variant-days[size] ÷ variant-days[size]',
        substituted: 'stands in for the spec\'s buy-vs-sell pair: how the range is spread across ' +
                     'sizes, against how often each size is unavailable'
      }),
      first_to_break: adapted({
        label: 'Sizes that run out most', rows: breakOrder.map(r => ({
          size: r.size_label, variants: r.variants, variants_out: r.variants_out,
          out_rate: pct(r.variants_out, r.variants)
        })),
        formula: 'distinct variants seen OOS ÷ distinct variants, per size (sizes with ≥5 variants)',
        substituted: 'the demand read the spec takes from sell-through, taken from scarcity instead'
      }),
      core_sizes: adapted({
        label: 'Core sizes', value: coreSizes,
        formula: 'the three sizes carrying the most variants',
        spec_formula: 'S/M/L for womenswear, M/L for menswear, modal three waists for denim',
        substituted: 'generalises the spec\'s own modal rule, since the category mix here is mixed'
      }),
      xl_residual_risk: unavailable({
        label: 'XL residual risk',
        spec_formula: 'Σ projected_residual ÷ Σ on_hand_XL',
        missing: ['unit counts', 'orders'], why: 'needs on-hand units and a decay curve from sales history'
      })
    },

    /* ── §4.4 Stockout-corrected demand ── */
    stockout: {
      oos_variant_days: computed({
        label: 'Variant-days out of stock', value: oos.oos_variant_days,
        formula: 'Σ_V count(day ∈ T₀ : variant not sellable)',
        spec_formula: 'Σ_V count(day ∈ T0 : inventory_level_V(day) ≤ 0)',
        period: 'T₀',
        note: 'read from the CSV\'s Inventory quantity column: blank = sellable, 0 = sold out'
      }),
      in_stock_variant_days: computed({
        label: 'Variant-days in stock', value: oos.in_stock_variant_days,
        formula: 'Σ_V count(day ∈ T₀ : variant sellable)', period: 'T₀'
      }),
      oos_rate: computed({
        label: 'Share of variant-days out of stock', unit: '%',
        value: pct(oos.oos_variant_days, oos.oos_variant_days + oos.in_stock_variant_days),
        formula: 'oos_variant_days ÷ (oos_variant_days + in_stock_variant_days)', period: 'T₀'
      }),
      net_str_corrected: unavailable({
        label: 'Stockout-corrected STR',
        spec_formula: 'baseline_velocity_per_in_stock_day × total_variant_days ÷ (opening_inventory + receipts)',
        missing: ['orders', 'returns', 'Klaviyo'],
        why: 'the correction needs units sold per in-stock day; the in-stock days are known, the units are not',
        have: 'in_stock_variant_days — the denominator of the spec\'s baseline velocity — is computed above'
      }),
      latent_demand_gap: unavailable({
        label: 'Latent demand gap',
        spec_formula: 'net_str_corrected − net_str_reported', missing: ['orders'],
        why: 'both terms are unavailable'
      }),
      bis_signups: unavailable({
        label: 'Back-in-stock signups', missing: ['Klaviyo'], why: 'private to the merchant' })
    },

    /* ── §4.5 Broken size timeline ── */
    broken_timeline: {
      rows: broken.map(r => ({
        handle: r.handle, title: r.title, product_type: r.product_type,
        first_broken_on: String(r.first_broken_on).slice(0, 10),
        at_baseline: r.at_baseline,
        days_broken: r.days_broken, days_observed: r.days_observed,
        broken_share: pct(r.days_broken, r.days_observed),
        sizes_missing: r.sizes_missing || []
      })),
      observed_breaks: computed({
        label: 'Styles seen breaking inside the window',
        value: brokenTotals.broke_inside_window,
        listed: broken.length,
        formula: 'styles whose first broken day is later than the first observed day',
        note: 'a style already broken on day one has no observable break date — the spec\'s ' +
              '"week each SKU broke" only exists for styles that transitioned while being watched'
      }),
      selection: adapted({
        label: 'Selection', value: 'styles with the most days broken',
        spec_formula: 'top 7 styles by net unit sales in T₀',
        substituted: 'ranking by sales is impossible; ranked by days broken instead, which changes ' +
                     'the question from "did your bestsellers break" to "which styles broke hardest"'
      }),
      loss_per_sku: unavailable({
        label: 'Loss per SKU',
        spec_formula: 'Σ (avg_velocity_pre_OOS × OOS_days_after_break × AUR)',
        missing: ['orders'], why: 'no velocity, no AUR'
      })
    },

    /* ── §4.6 Wasted ad spend ── */
    ad_waste: {
      wasted_ad_spend: unavailable({ label: 'Spend on OOS-at-size PDPs', missing: ['Meta Ads', 'Google Ads'] }),
      waste_share:     unavailable({ label: 'Share of paid spend', missing: ['Meta Ads', 'Google Ads'] }),
      oos_sessions:    unavailable({ label: 'Sessions that hit out-of-stock', missing: ['GA4'] }),
      cr_oos:          unavailable({ label: 'CR on OOS sessions', missing: ['GA4'] }),
      note: 'this entire section of the spec reads the merchant\'s own ad and analytics accounts'
    },

    /* ── §4.7–4.9 Plays, recipe, trajectory ── */
    plays: {
      note: 'the spec\'s three plays are reorder, ad-feed and markdown actions on your own store. ' +
            'This tracker watches a store from outside, so there is nothing to execute — and every ' +
            'figure attached to them is a currency amount that needs order data.',
      play_01_lift:      unavailable({ label: 'Reorder lift', missing: ['orders', 'purchase orders', 'margin'] }),
      play_02_recapture: unavailable({ label: 'Ad spend recapture', missing: ['Meta Ads', 'Google Ads'] }),
      play_03_avoided:   unavailable({ label: 'Markdown avoidance', missing: ['unit counts', 'margin'] })
    },
    trajectory: {
      gmv_no_action:   unavailable({ label: 'Current trajectory', missing: ['orders'] }),
      gmv_with_plays:  unavailable({ label: 'Recommended trajectory', missing: ['orders'] }),
      revenue_delta:   unavailable({ label: 'Revenue delta', missing: ['orders'] }),
      gm_delta:        unavailable({ label: 'Gross margin delta', missing: ['margin'] }),
      note: 'a cumulative-GMV forecast needs a starting revenue line; the feed has prices but no sales'
    },

    /* ── What this feed does support, in place of §4.2 and §4.9 ── */
    pricing: {
      note: 'outside the spec. The spec\'s reader owns the store and knows its own prices; ' +
            'for a watched store this is the strongest signal the feed carries.',
      price_drops: computed({ label: 'Price drops', value: priceMoves.drops,
        formula: "count(change_type = 'price_down' and not baseline)", period: 'T₀' }),
      price_rises: computed({ label: 'Price rises', value: priceMoves.rises,
        formula: "count(change_type = 'price_up' and not baseline)", period: 'T₀' }),
      discount_moves: computed({ label: 'Discount-only changes', value: priceMoves.discount_moves,
        formula: "count(change_type = 'discount_change')", period: 'T₀' }),
      avg_move_pct: computed({ label: 'Average move', unit: '%', value: num(priceMoves.avg_move_pct),
        formula: 'avg(|price_diff_pct|) over price changes', period: 'T₀' }),
      max_move_pct: computed({ label: 'Largest move', unit: '%', value: num(priceMoves.max_move_pct),
        formula: 'max(|price_diff_pct|) over price changes', period: 'T₀' }),
      biggest_drops: biggestDrops.map(r => ({
        title: r.title, variant: r.variant_label, sku: r.sku,
        from: num(r.prev_price), to: num(r.price),
        diff: num(r.price_diff), diff_pct: num(r.price_diff_pct),
        discount_pct: num(r.discount_pct), on: String(r.observed_date).slice(0, 10), handle: r.handle
      })),
      discount_bands: discountBands.map(r => ({ band: r.band, variants: r.variants })),
      price_spread: {
        min: num(priceSpread?.min_price), median: num(priceSpread?.median_price),
        max: num(priceSpread?.max_price), currency: store.currency
      }
    },

    assortment: {
      new_variants:     computed({ label: 'New variants', value: assortment.new_variants,
        formula: "count(change_type = 'new' and not baseline)", period: 'T₀' }),
      removed_variants: computed({ label: 'Variants removed', value: assortment.removed_variants,
        formula: "count(change_type = 'removed')", period: 'T₀' }),
      went_out:         computed({ label: 'Went out of stock', value: assortment.went_out,
        formula: "count(change_type = 'stock_out')", period: 'T₀' }),
      came_back:        computed({ label: 'Came back in stock', value: assortment.came_back,
        formula: "count(change_type = 'stock_in')", period: 'T₀' }),
      categories: categories.map(r => ({
        product_type: r.product_type, styles: r.styles, variants: r.variants,
        oos_rate: pct(r.oos_days, r.variant_days),
        avg_price: num(r.avg_price), avg_discount: num(r.avg_discount)
      }))
    },

    /* ── §5 · confidence, §6 · checks, §7 · edge cases ── */
    confidence: {
      spec_interval: unavailable({
        label: 'Confidence interval',
        spec_formula: 'σ_Y from the variance of velocity, lead time, AUR and returns',
        missing: ['orders', 'returns', 'purchase orders'],
        why: 'three of the four variance terms have no data behind them'
      }),
      coverage
    },
    sanity_checks: checks,
    edge_cases: [
      { case: 'Multi-location inventory', applies: false,
        finding: 'the feed reports one availability flag per variant, so there are no locations to reconcile' },
      { case: 'Variant explosion', applies: edges.max_variants_per_style >= 30,
        finding: `largest style carries ${edges.max_variants_per_style} variants` +
                 (edges.max_variants_per_style >= 30
                   ? ' — the spec\'s 2D-pack-ratio case; a size curve on this style is thin per cell'
                   : '') },
      { case: 'Cold-start (new SKUs)', applies: edges.cold_start_variants > 0,
        finding: `${edges.cold_start_variants} variant(s) first appeared after the window opened` },
      { case: 'Returns lag', applies: false, finding: 'no returns data to lag' },
      { case: 'Unit counts', applies: true,
        finding: edges.rows_with_qty === 0
          ? 'the Inventory quantity column is empty on all history rows — availability is a boolean here, never a count'
          : `${edges.rows_with_qty} history row(s) carry a real quantity` },
      { case: 'Currency', applies: true,
        finding: `all figures in ${store.currency}, as published by the store` }
    ]
  }
}

/** Flat list of every spec variable and how it resolved — drives the coverage table. */
export function coverageTable (facts) {
  const out = []
  const walk = (section, obj) => {
    for (const [key, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object' && typeof v.status === 'string') {
        out.push({
          section, variable: key, label: v.label || key, status: v.status,
          missing: v.missing || null
        })
      }
    }
  }
  walk('01 Headline',        facts.headline)
  walk('02 Opportunity',     facts.opportunity_stack)
  walk('03a Size curve',     facts.size_curve)
  walk('03b Stockout',       facts.stockout)
  walk('03c Broken timeline', facts.broken_timeline)
  walk('03d Ad waste',       facts.ad_waste)
  walk('04 Plays',           facts.plays)
  walk('06 Trajectory',      facts.trajectory)
  walk('Periods',            facts.periods)
  return out
}
