/**
 * The sales report, as HTML.
 *
 * Rewritten to answer the question a reader actually opens it with — how is this
 * store trading — rather than to walk the specification top to bottom.
 *
 * The old version was built from a sample template that assumed order lines, ad
 * spend and supplier terms. None of that exists in a public product feed, so
 * whole sections were a heading followed by an explanation of what was missing:
 * the opportunity stack, the three plays, the GMV trajectory, the ad-waste
 * block, the confidence interval, and an appendix restating every formula. They
 * are gone. One short paragraph at the end says what the report is built on,
 * which is all a reader needs to judge it.
 *
 * The rule everywhere below: a measure is rendered only when it was actually
 * computed. Anything the feed could not answer is silently absent rather than
 * present as an apology.
 */

const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const nf = n => n == null ? '—' : new Intl.NumberFormat('en-US').format(
  typeof n === 'number' && !Number.isInteger(n) ? Math.round(n * 100) / 100 : n)

/** A measure is worth showing when the data behind it existed. */
const has = m => m && (m.status === 'computed' || m.status === 'adapted')
const val = m => has(m) ? m.value : null

const dt = s => s
  ? new Date(String(s).slice(0, 10) + 'T00:00:00Z')
      .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—'

/* ── pieces ───────────────────────────────────────────────────────── */

const fig = (label, value, sub, tone) => `
  <div class="fig${tone ? ' ' + tone : ''}">
    <div class="fig-v">${value}</div>
    <div class="fig-l">${esc(label)}</div>
    ${sub ? `<div class="fig-s">${esc(sub)}</div>` : ''}
  </div>`

/** Horizontal bar, wherever one row should be read against the others. */
const bar = (pct, tone) =>
  `<span class="bar${tone ? ' ' + tone : ''}" style="width:${Math.max(1, Math.min(100, pct || 0))}%"></span>`

/**
 * One stacked column per observed day. Built from divs rather than SVG so it
 * reflows with the page and prints, and because the shape is the point here —
 * an exact axis would invite reading values off it that the tooltip gives
 * properly.
 */
function dayChart (rows, cur) {
  if (!rows.length) return ''
  const max = Math.max(1, ...rows.map(r => r.total))
  const parts = [
    ['new_items', 'new', 'New'],
    ['price_down', 'down', 'Price down'],
    ['price_up', 'up', 'Price up'],
    ['stock_out', 'out', 'Out of stock'],
    ['stock_in', 'in', 'Back in stock'],
    ['removed', 'gone', 'Removed'],
    ['relisted', 'back', 'Relisted'],
  ]
  const step = Math.max(1, Math.ceil(rows.length / 9))
  return `
    <div class="chart">
      <div class="cols">
        ${rows.map(r => `
          <div class="col" title="${esc(r.date)} · ${nf(r.total)} changes">
            <div class="stack" style="height:${Math.max(2, r.total / max * 100)}%">
              ${parts.map(([k, cls]) => r[k]
                ? `<span class="sg ${cls}" style="flex:${r[k]}"></span>` : '').join('')}
            </div>
          </div>`).join('')}
      </div>
      <div class="axis">
        ${rows.map((r, i) => `<span>${i % step === 0 || i === rows.length - 1
          ? esc(r.date.slice(8) + ' ' + new Date(r.date + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short' }))
          : ''}</span>`).join('')}
      </div>
      <div class="key">
        ${parts.map(([, cls, label]) => `<span><i class="${cls}"></i>${label}</span>`).join('')}
      </div>
    </div>`
}

const section = (num, title, lead, body) => `
  <section>
    <div class="s-head">
      <span class="s-num">${num}</span>
      <div>
        <h2>${esc(title)}</h2>
        ${lead ? `<p class="lead">${esc(lead)}</p>` : ''}
      </div>
    </div>
    ${body}
  </section>`

/* ── the document ─────────────────────────────────────────────────── */

export function renderReport ({ facts, narrative, id, docNo, coverage }) {
  const f = facts
  const n = narrative || {}
  const cur = f.store.currency
  const t = f.top_sellers || { rows: [], days_covered: 0, distinct_products: 0 }
  const p = f.pricing || {}
  const a = f.assortment || {}
  const sc = f.size_curve || {}
  const so = f.stockout || {}
  const bt = f.broken_timeline || {}
  const cov = (f.confidence && f.confidence.coverage) || {}
  const days = f.window.run_dates.length

  /* ── the band across the top: the store in six numbers ── */
  const figures = [
    has(f.headline.style_count) &&
      fig('Styles', nf(val(f.headline.style_count)), 'distinct products seen'),
    has(f.headline.variant_count) &&
      fig('Variants', nf(val(f.headline.variant_count)), 'size and colour combinations'),
    has(so.oos_rate) &&
      fig('Out of stock', val(so.oos_rate) + '%', 'of all variant-days',
          val(so.oos_rate) > 25 ? 'warn' : ''),
    has(f.headline.broken_style_pct) &&
      fig('Broken on size', val(f.headline.broken_style_pct) + '%',
          `${nf(f.headline.broken_style_pct.numerator)} of ${nf(f.headline.broken_style_pct.denominator)} sized styles`,
          val(f.headline.broken_style_pct) > 40 ? 'warn' : ''),
    has(p.price_drops) &&
      fig('Price drops', nf(val(p.price_drops)), `against ${nf(val(p.price_rises))} rises`),
    t.rows.length &&
      fig('Best sellers', nf(t.distinct_products), `held a place over ${t.days_covered} days`),
  ].filter(Boolean).join('')

  /* ── best sellers, the store's own ranking ── */
  const maxDaysT = Math.max(1, ...t.rows.map(r => r.days_ranked))
  const topOut = t.rows.filter(r => r.variants && r.in_stock_variants === 0)
  const topBody = t.rows.length ? `
    <div class="figs small">
      ${fig('Held a place', nf(t.distinct_products), 'distinct products')}
      ${fig('Arrived', nf(t.entered), 'newly in the top 20', 'up')}
      ${fig('Dropped out', nf(t.dropped), 'left before the window ended', 'down')}
      ${fig('Held throughout', nf(t.held), `all ${t.days_covered} days`)}
    </div>
    ${topOut.length ? `<p class="alert"><b>${topOut.length}</b> of these best sellers
      ${topOut.length === 1 ? 'is' : 'are'} out of stock in every variant right now —
      the most expensive kind of gap, because demand is proven.</p>` : ''}
    <div class="tw">
      <table>
        <thead><tr>
          <th>Product</th><th>Type</th><th class="r">Days ranked</th>
          <th class="r">Price</th><th class="r">Discount</th><th class="r">In stock</th><th class="r">Seen</th>
        </tr></thead>
        <tbody>
          ${t.rows.map(r => `
          <tr>
            <td class="prod">
              <div class="pt">${esc(r.title)}</div>
              <div class="ph">${esc(r.handle)}</div>
            </td>
            <td class="dim">${esc(r.product_type || '—')}</td>
            <td class="r nowrap">
              <span class="dbar">${bar(r.days_ranked / maxDaysT * 100)}</span><b>${r.days_ranked}</b>
            </td>
            <td class="r mono">${r.price == null ? '—' : nf(r.price)}</td>
            <td class="r mono">${r.discount_pct ? `<span class="down">${r.discount_pct}%</span>` : '—'}</td>
            <td class="r mono">${r.variants
              ? `<span class="${r.in_stock_variants === 0 ? 'up' : ''}">${r.in_stock_variants}/${r.variants}</span>`
              : '—'}</td>
            <td class="r mono dim nowrap">${esc(r.first_day.slice(5))} – ${esc(r.last_day.slice(5))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="foot">Ranked by how many of the ${t.days_covered} covered days each product held
    a place. The export marks a best seller but does not number it, so time held is the
    ranking — a product marked every day is a steadier seller than one marked once.</p>`
    : `<p class="none">This store's export does not carry the best-seller column, so there is
       nothing to rank. That is a property of the file, not a gap in the store.</p>`

  /* ── stock health ── */
  const breakRows = (sc.first_to_break && sc.first_to_break.rows) || []
  const sizeRows = (sc.size_mix && sc.size_mix.rows) || []
  const maxShare = Math.max(1, ...sizeRows.map(r => r.share || 0))
  const maxOos = Math.max(1, ...breakRows.map(r => r.out_rate || 0))
  const stockBody = `
    <div class="grid2">
      <div>
        <h3>How much of the range was sellable</h3>
        ${has(so.oos_rate) ? `
        <div class="split">
          <div class="split-bar">
            <span class="seg in" style="width:${100 - val(so.oos_rate)}%"></span>
            <span class="seg out" style="width:${val(so.oos_rate)}%"></span>
          </div>
          <div class="split-key">
            <span><i class="in"></i>In stock · ${nf(val(so.in_stock_variant_days))} variant-days</span>
            <span><i class="out"></i>Out of stock · ${nf(val(so.oos_variant_days))}</span>
          </div>
        </div>` : ''}
        ${n.reads && n.reads.stockout ? `<p>${esc(n.reads.stockout)}</p>` : ''}
      </div>
      <div>
        <h3>The range by size</h3>
        ${sizeRows.length ? `
        <div class="rows">
          ${sizeRows.slice(0, 8).map(r => `
            <div class="row">
              <span class="k mono">${esc(r.size)}</span>
              <span class="t">${bar((r.share || 0) / maxShare * 100)}</span>
              <span class="v mono">${r.share}% · ${nf(r.variants)}</span>
            </div>`).join('')}
        </div>` : ''}
      </div>
      <div>
        <h3>Sizes that run out first</h3>
        ${breakRows.length ? `
        <div class="rows">
          ${breakRows.slice(0, 8).map(r => `
            <div class="row">
              <span class="k mono">${esc(r.size)}</span>
              <span class="t">${bar((r.out_rate || 0) / maxOos * 100, 'warn')}</span>
              <span class="v mono">${r.out_rate}%</span>
            </div>`).join('')}
        </div>
        ${has(sc.core_sizes) ? `<p class="foot">Core sizes by volume: <b>${esc(String(val(sc.core_sizes)))}</b>.</p>` : ''}`
        : '<p class="none">This range does not carry a size option.</p>'}
      </div>
    </div>`

  /* ── styles with a hole in the ladder ── */
  const bRows = bt.rows || []
  const maxBroken = Math.max(1, ...bRows.map(r => r.days_broken || 0))
  const brokenBody = bRows.length ? `
    <div class="tw">
      <table>
        <thead><tr><th>Style</th><th>Type</th><th class="r">Sizes missing</th><th class="r">Days broken</th></tr></thead>
        <tbody>
          ${bRows.slice(0, 10).map(r => `
          <tr>
            <td class="prod"><div class="pt">${esc(r.title)}</div><div class="ph">${esc(r.handle)}</div></td>
            <td class="dim">${esc(r.product_type || '—')}</td>
            <td class="r mono">${esc((r.sizes_missing || []).join(', ') || '—')}</td>
            <td class="r nowrap"><span class="dbar">${bar((r.days_broken || 0) / maxBroken * 100, 'warn')}</span><b>${r.days_broken}</b></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${has(bt.observed_breaks) ? `<p class="foot">${nf(val(bt.observed_breaks))} styles were seen breaking
      inside the window; the ten carrying it longest are shown.</p>` : ''}`
    : ''

  /* ── pricing ── */
  const drops = p.biggest_drops || []
  const bands = p.discount_bands || []
  const maxBand = Math.max(1, ...bands.map(b => b.variants || 0))
  const pricingBody = `
    <div class="figs small">
      ${has(p.price_drops) ? fig('Drops', nf(val(p.price_drops)), null, 'down') : ''}
      ${has(p.price_rises) ? fig('Rises', nf(val(p.price_rises)), null, 'up') : ''}
      ${has(p.discount_moves) ? fig('Discount only', nf(val(p.discount_moves))) : ''}
      ${has(p.avg_move_pct) ? fig('Average move', val(p.avg_move_pct) + '%') : ''}
      ${has(p.max_move_pct) ? fig('Largest move', val(p.max_move_pct) + '%') : ''}
    </div>
    <div class="grid2">
      <div>
        <h3>Where the range sits on discount</h3>
        ${bands.length ? `
        <div class="rows">
          ${bands.map(b => `
            <div class="row">
              <span class="k">${esc(b.band)}</span>
              <span class="t">${bar((b.variants || 0) / maxBand * 100)}</span>
              <span class="v mono">${nf(b.variants)}</span>
            </div>`).join('')}
        </div>` : ''}
        ${p.price_spread ? `<p class="foot">Prices run ${nf(p.price_spread.min)} to
          ${nf(p.price_spread.max)} ${esc(cur)}, median <b>${nf(p.price_spread.median)}</b>.</p>` : ''}
      </div>
      <div>
        <h3>Steepest drops</h3>
        ${drops.length ? `
        <div class="drops">
          ${drops.slice(0, 6).map(d => `
            <div class="drop">
              <div class="d-t">${esc(d.title)}</div>
              ${d.variant ? `<div class="d-v">${esc(d.variant)}</div>` : ''}
              <div class="d-n mono">${nf(d.from)} → <b>${nf(d.to)}</b> ${esc(cur)}
                <span class="down">${d.diff_pct}%</span>
                ${d.on ? `<span class="d-on">on ${esc(d.on.slice(5))}</span>` : ''}
                ${d.discount_pct ? `<span class="d-on">now ${d.discount_pct}% off</span>` : ''}</div>
            </div>`).join('')}
        </div>` : '<p class="none">No price moves in this window.</p>'}
      </div>
    </div>`

  /* ── assortment ── */
  const cats = a.categories || []
  const maxCat = Math.max(1, ...cats.map(c => c.variants || c.n || 0))
  const assortBody = `
    <div class="figs small">
      ${has(a.new_variants) ? fig('Added', nf(val(a.new_variants)), null, 'up') : ''}
      ${has(a.removed_variants) ? fig('Removed', nf(val(a.removed_variants)), null, 'down') : ''}
      ${has(a.went_out) ? fig('Went out of stock', nf(val(a.went_out))) : ''}
      ${has(a.came_back) ? fig('Came back', nf(val(a.came_back))) : ''}
      ${has(a.relisted) ? fig('Relisted', nf(val(a.relisted))) : ''}
    </div>
    ${cats.length ? `
    <h3>By category</h3>
    <div class="tw">
      <table>
        <thead><tr>
          <th>Type</th><th class="r">Styles</th><th class="r">Variants</th>
          <th class="r">Out of stock</th><th class="r">Avg price</th><th class="r">Avg discount</th>
        </tr></thead>
        <tbody>
          ${cats.slice(0, 10).map(c => `
          <tr>
            <td><b>${esc(c.product_type || '—')}</b></td>
            <td class="r mono">${nf(c.styles)}</td>
            <td class="r nowrap">
              <span class="dbar">${bar((c.variants || 0) / maxCat * 100)}</span><b>${nf(c.variants)}</b>
            </td>
            <td class="r mono">${c.oos_rate == null ? '—'
              : `<span class="${c.oos_rate > 30 ? 'up' : ''}">${c.oos_rate}%</span>`}</td>
            <td class="r mono">${nf(c.avg_price)}</td>
            <td class="r mono">${c.avg_discount ? c.avg_discount + '%' : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="foot">Out-of-stock share is of that category's variant-days, so a small
    category that is always short reads as badly as a large one that is short for a week.</p>` : ''}
    ${n.reads && n.reads.assortment ? `<p>${esc(n.reads.assortment)}</p>` : ''}`

  /* ── what to do ── */
  const actions = (n.actions || []).map((x, i) => `
    <div class="act">
      <span class="act-n">${i + 1}</span>
      <div>
        <h3>${esc(x.title)}</h3>
        <p>${esc(x.why)}</p>
        <p class="watch"><span class="caps">Watch</span>${esc(x.watch)}</p>
      </div>
    </div>`).join('')

  /* Numbering follows what is actually rendered, so a store with no broken
     ladders does not show a gap where section 04 would have been. */
  let k = 1
  const num = () => String(++k).padStart(2, '0')

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sales Report · ${esc(f.store.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Spectral:ital,wght@0,300;0,400;0,600;1,400&display=swap" rel="stylesheet">
<style>
:root{
  --paper:#fbfbfa; --surface:#ffffff; --panel:#f2f4f5;
  --ink:#12161a; --ink-2:#3f4a52; --muted:#6d787f;
  --line:#e2e6e8; --rule:#c8cfd3;
  --accent:#1b3a6b; --accent-soft:#dde5f0;
  --copper:#9a5b2d; --up:#9c3524; --down:#14655c;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#0e1114; --surface:#151a1e; --panel:#1c2328;
  --ink:#e9ecee; --ink-2:#b4bdc3; --muted:#8a949b;
  --line:#242c31; --rule:#37424a;
  --accent:#7ba4de; --accent-soft:#152538;
  --copper:#d69a5f; --up:#e08469; --down:#59bdb0;
}}
:root[data-theme="dark"]{
  --paper:#0e1114; --surface:#151a1e; --panel:#1c2328;
  --ink:#e9ecee; --ink-2:#b4bdc3; --muted:#8a949b;
  --line:#242c31; --rule:#37424a;
  --accent:#7ba4de; --accent-soft:#152538;
  --copper:#d69a5f; --up:#e08469; --down:#59bdb0;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--paper);color:var(--ink);
  font:400 16.5px/1.62 Spectral,Georgia,serif;-webkit-font-smoothing:antialiased}
.doc{max-width:1080px;margin:0 auto;background:var(--surface);box-shadow:0 0 0 1px var(--line)}
h1,h2,h3{font-family:Spectral,Georgia,serif;font-weight:600;letter-spacing:-.015em;line-height:1.16}
.caps,th,.fig-l,.s-num,.eyebrow{font-family:Archivo,system-ui,sans-serif}
.mono,.fig-v{font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}

.top{padding:34px clamp(20px,5vw,58px);border-bottom:1px solid var(--line);
  display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap}
.eyebrow{font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;
  color:var(--accent);margin-bottom:9px}
h1{font-size:clamp(27px,3.6vw,38px);text-wrap:balance}
.sub{color:var(--muted);font-size:14px;margin-top:6px}
.doc-meta{text-align:right;font-family:"IBM Plex Mono",monospace;font-size:11.5px;
  color:var(--muted);line-height:1.9;font-variant-numeric:tabular-nums}

.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:1px;
  background:var(--line);border-bottom:1px solid var(--line)}
.figs.small{border:1px solid var(--line);border-radius:10px;overflow:hidden;
  margin-bottom:22px;border-bottom:1px solid var(--line)}
.fig{background:var(--surface);padding:17px 18px}
.fig-v{font-size:25px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.fig-l{font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;
  color:var(--muted);margin-top:7px}
.fig-s{font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.4}
.fig.warn .fig-v{color:var(--up)}
.fig.up .fig-v{color:var(--up)}
.fig.down .fig-v{color:var(--down)}

section{padding:clamp(30px,4vw,50px) clamp(20px,5vw,58px)}
section+section{border-top:1px solid var(--line)}
.s-head{display:flex;gap:16px;align-items:baseline;margin-bottom:22px}
.s-num{font-size:11px;font-weight:700;letter-spacing:.12em;color:var(--copper);
  padding-top:6px;font-variant-numeric:tabular-nums}
h2{font-size:clamp(21px,2.6vw,27px);text-wrap:balance}
h3{font-size:16px;margin-bottom:11px}
.lead{color:var(--ink-2);font-size:16px;margin-top:5px;max-width:62ch}
p{color:var(--ink-2);margin-top:11px;max-width:66ch}
.foot{font-size:13.5px;color:var(--muted);margin-top:13px;max-width:70ch}
.none{font-size:14px;color:var(--muted);font-style:italic;margin-top:8px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:34px}

.tw{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-family:Archivo,sans-serif;font-size:13.5px}
th,td{text-align:left;padding:10px 13px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
th{font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
  color:var(--muted);background:var(--panel);white-space:nowrap}
td.r,th.r{text-align:right}
.nowrap{white-space:nowrap}
.prod{min-width:230px}
.pt{font-weight:600;line-height:1.3}
.ph{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--muted);
  margin-top:2px;word-break:break-all}
.dim{color:var(--muted)}
.up{color:var(--up)}
.down{color:var(--down)}

.bar{display:inline-block;height:5px;border-radius:3px;background:var(--accent);vertical-align:middle}
.bar.warn{background:var(--copper)}
.dbar{display:inline-block;width:64px;margin-right:9px;vertical-align:middle;
  background:var(--panel);border-radius:3px;line-height:0}
.rows{display:flex;flex-direction:column;gap:7px}
.row{display:grid;grid-template-columns:88px 1fr auto;gap:11px;align-items:center;
  font-family:Archivo,sans-serif;font-size:13px}
.row .k{color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .t{background:var(--panel);border-radius:3px;line-height:0}
.row .v{color:var(--muted);font-size:12px;white-space:nowrap}

.split{margin:4px 0 12px}
.split-bar{display:flex;height:11px;border-radius:6px;overflow:hidden;background:var(--panel)}
.seg.in{background:var(--down)}
.seg.out{background:var(--copper)}
.split-key{display:flex;gap:18px;flex-wrap:wrap;margin-top:9px;
  font-family:Archivo,sans-serif;font-size:12px;color:var(--muted)}
.split-key i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}
.split-key i.in{background:var(--down)}
.split-key i.out{background:var(--copper)}

/* daily shape */
.chart{margin-top:4px}
.cols{display:flex;align-items:flex-end;gap:3px;height:132px;padding:0 1px;
  border-bottom:1px solid var(--rule)}
.col{flex:1;height:100%;display:flex;align-items:flex-end;min-width:0}
.stack{width:100%;display:flex;flex-direction:column-reverse;border-radius:2px 2px 0 0;
  overflow:hidden;background:var(--panel)}
.sg{width:100%;min-height:1px}
.sg.new{background:var(--accent)}
.sg.down{background:var(--down)}
.sg.up{background:var(--up)}
.sg.out{background:var(--copper)}
.sg.in{background:#7aa6a0}
.sg.gone{background:#8d939a}
.sg.back{background:#b9c3cc}
.axis{display:flex;gap:3px;padding-top:7px;font-family:"IBM Plex Mono",monospace;
  font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums}
.axis span{flex:1;min-width:0;text-align:center;white-space:nowrap;overflow:hidden}
.key{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;font-family:Archivo,sans-serif;
  font-size:11.5px;color:var(--muted)}
.key i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}
.key i.new{background:var(--accent)} .key i.down{background:var(--down)}
.key i.up{background:var(--up)} .key i.out{background:var(--copper)}
.key i.in{background:#7aa6a0} .key i.gone{background:#8d939a} .key i.back{background:#b9c3cc}

/* a best seller with nothing left to sell is worth calling out */
.alert{background:var(--accent-soft);border-left:3px solid var(--accent);
  padding:11px 15px;border-radius:0 8px 8px 0;font-size:14.5px;margin:0 0 16px;max-width:none}

.d-v{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--muted);margin-top:2px}
.d-on{color:var(--muted);margin-left:9px;font-size:11.5px}

.drops{display:flex;flex-direction:column;gap:11px}
.drop{padding-bottom:10px;border-bottom:1px solid var(--line)}
.drop:last-child{border-bottom:0;padding-bottom:0}
.d-t{font-family:Archivo,sans-serif;font-weight:600;font-size:13.5px;line-height:1.3}
.d-n{font-size:12.5px;color:var(--muted);margin-top:3px}

.act{display:flex;gap:16px;padding:16px 0;border-bottom:1px solid var(--line)}
.act:last-child{border-bottom:0}
.act-n{font-family:"IBM Plex Mono",monospace;font-size:12px;font-weight:600;
  color:var(--copper);flex:0 0 auto;padding-top:3px}
.act p{margin-top:5px;font-size:15px}
.watch{font-size:13.5px;color:var(--muted)}
.caps{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
  color:var(--accent);margin-right:7px}

.scope{background:var(--panel)}
.scope p{font-size:13.5px;color:var(--muted);max-width:78ch;margin-top:0}
@media print{body{background:#fff}.doc{box-shadow:none;max-width:none}section{break-inside:avoid}}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
</head><body>
<div class="doc">

  <div class="top">
    <div>
      <div class="eyebrow">Sales report</div>
      <h1>${esc(f.store.name)}</h1>
      <div class="sub">${esc(f.store.domain)} · ${esc(cur)} · ${dt(f.window.from)} – ${dt(f.window.to)}</div>
    </div>
    <div class="doc-meta">
      ${docNo ? `<div>${esc(docNo)}</div>` : ''}
      <div>${days} days observed</div>
      ${cov.completeness != null ? `<div>${cov.completeness}% coverage</div>` : ''}
    </div>
  </div>

  <div class="figs">${figures}</div>

  ${n.headline_verdict ? `
  <section>
    <div class="s-head"><span class="s-num">01</span><div>
      <h2>${esc(n.headline_verdict)}</h2>
      ${n.headline_context ? `<p class="lead">${esc(n.headline_context)}</p>` : ''}
    </div></div>
  </section>` : ''}

  ${f.daily_shape && f.daily_shape.length ? section(num(), 'How the window unfolded',
    'Every recorded change, by day and by kind. A tall column is a day the store moved a lot.',
    dayChart(f.daily_shape, cur) + `
    <p class="foot">${nf(f.daily_shape.reduce((s, d) => s + d.total, 0))} changes over
    ${f.daily_shape.length} days, an average of
    ${nf(Math.round(f.daily_shape.reduce((s, d) => s + d.total, 0) / f.daily_shape.length))} a day.
    A day with no column is a day the scrape ran and found nothing changed.</p>`) : ''}

  ${section(num(), 'Best sellers',
    t.rows.length
      ? `The ${t.rows.length} products this store marked as its own top sellers, across ${t.days_covered} days.`
      : 'What the store reports as its own top sellers.',
    topBody)}

  ${section(num(), 'Stock health',
    'How much of the range was sellable, and which sizes ran out first.',
    stockBody)}

  ${brokenBody ? section(num(), 'Styles missing a size',
    'Still listed, but no longer buyable in part of the ladder.',
    brokenBody) : ''}

  ${section(num(), 'Pricing',
    'What moved, how far, and where the range sits on discount.',
    pricingBody)}

  ${section(num(), 'Assortment',
    'What entered the range and what left it.',
    assortBody)}

  ${actions ? section(num(), 'What to follow next',
    'Three things worth watching in the next window.', actions) : ''}

  <section class="scope">
    <p><b>What this is built on.</b> Every figure comes from this store's own public
    product feed, read once a day for ${days} days${cov.completeness != null ? ` (${cov.completeness}% of the window)` : ''}.
    That feed carries prices, stock and the range; it does not carry orders, returns,
    ad spend or supplier terms, so nothing here is a revenue or margin figure.
    ${n.verified ? esc(n.verified) : ''}</p>
  </section>

</div>
</body></html>`
}
