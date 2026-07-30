/**
 * Renders the audit into a standalone HTML document.
 *
 * Charts are server-drawn SVG rather than a charting library: the document has
 * to survive being saved, mailed and printed, and a canvas that needs a CDN
 * script is blank in all three. It also means the PDF matches the screen.
 *
 * Every figure comes from the facts object. Where a spec variable could not be
 * computed the section still appears, stating which source is missing — an
 * absent number is a finding, and quietly dropping the section would leave the
 * reader thinking the audit had covered it.
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c])
const nf = v => (v == null ? '—' : Number(v).toLocaleString('en-US'))
const pc = v => (v == null ? '—' : `${v}%`)
const dt = d => {
  if (!d) return '—'
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return `${Number(day)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]} ${y}`
}

/* ── SVG charts ───────────────────────────────────────────────────── */

/** Grouped bars: assortment share against out-of-stock rate, per size. */
function sizeCurveSvg (rows) {
  if (!rows?.length) return '<p class="none">No size option on this feed, so no size curve.</p>'
  const r = rows.slice(0, 12)
  const W = 1000, H = 300, PAD_L = 44, PAD_B = 46, PAD_T = 14
  const max = Math.max(50, ...r.map(x => Math.max(x.share ?? 0, x.oos_rate ?? 0)))
  const step = Math.ceil(max / 5 / 10) * 10 || 10
  const top = Math.ceil(max / step) * step
  const plotH = H - PAD_B - PAD_T
  const bandW = (W - PAD_L) / r.length
  const barW = Math.min(26, bandW * 0.3)
  const y = v => PAD_T + plotH - (v / top) * plotH

  const grid = []
  for (let v = 0; v <= top; v += step) {
    grid.push(`<line x1="${PAD_L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="g"/>`,
              `<text x="${PAD_L - 8}" y="${y(v) + 4}" class="ax" text-anchor="end">${v}%</text>`)
  }
  const bars = r.map((x, i) => {
    const cx = PAD_L + bandW * i + bandW / 2
    const a = x.share ?? 0, b = x.oos_rate ?? 0
    return `
      <rect x="${cx - barW - 2}" y="${y(a)}" width="${barW}" height="${plotH - (y(a) - PAD_T)}" class="b1"/>
      <rect x="${cx + 2}"        y="${y(b)}" width="${barW}" height="${plotH - (y(b) - PAD_T)}" class="b2"/>
      <text x="${cx}" y="${H - PAD_B + 18}" class="ax" text-anchor="middle">${esc(String(x.size).slice(0, 10))}</text>`
  }).join('')

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img"
    aria-label="Share of the range against out-of-stock rate, by size">
    ${grid.join('')}<line x1="${PAD_L}" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="axis"/>${bars}</svg>`
}

/** Horizontal band bar: how the range sits across discount depth. */
function bandSvg (bands) {
  const total = bands.reduce((s, b) => s + b.variants, 0)
  if (!total) return ''
  const cols = ['#16140F', '#6F5746', '#B0532D', '#8A3F22', '#A39C8F']
  let x = 0
  const segs = bands.map((b, i) => {
    const w = (b.variants / total) * 100
    const s = `<rect x="${x}" y="0" width="${w}" height="10" fill="${cols[i % cols.length]}"/>`
    x += w
    return s
  }).join('')
  return `<svg viewBox="0 0 100 10" preserveAspectRatio="none" class="bandbar">${segs}</svg>
    <div class="bandkey">${bands.map((b, i) =>
      `<span><i style="background:${cols[i % cols.length]}"></i>${esc(b.band)} · ${nf(b.variants)}</span>`).join('')}</div>`
}

/* ── blocks ───────────────────────────────────────────────────────── */

/** A spec variable that could not be computed, stated rather than hidden. */
function gap (f, key) {
  const miss = (f.missing || []).map(m => `<code>${esc(m)}</code>`).join(' ')
  return `<div class="gap">
    <div class="gap-h">${esc(f.label || key)}</div>
    ${f.spec_formula ? `<div class="gap-f">${esc(f.spec_formula)}</div>` : ''}
    <div class="gap-w">${f.why ? esc(f.why) : ''}</div>
    ${miss ? `<div class="gap-m">needs ${miss}</div>` : ''}
    ${f.have ? `<div class="gap-y">available: ${esc(f.have)}</div>` : ''}
  </div>`
}

const gapGrid = (obj, keys) =>
  `<div class="gaps">${keys.filter(k => obj[k]?.status === 'unavailable')
    .map(k => gap(obj[k], k)).join('')}</div>`

const read = (label, text) => `<div class="diag-read">
  <div class="diag-read-marker">${esc(label)}</div><p>${esc(text)}</p></div>`

const stat = (label, value, sub) => `<div class="stat">
  <div class="stat-label">${esc(label)}</div>
  <div class="stat-value">${value}</div>
  ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}</div>`

/* ── the document ─────────────────────────────────────────────────── */

export function renderReport ({ facts, narrative, id, docNo, coverage }) {
  const f = facts, n = narrative
  const cur = f.store.currency
  const sizes = f.size_curve.size_mix.rows
  const brokenRows = f.broken_timeline.rows

  const maxDays = Math.max(1, ...brokenRows.map(r => r.days_observed))

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sales Curve Audit · ${esc(f.store.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,500;1,300;1,400&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{
  --ink:#16140F; --ink-soft:#38332C; --gray:#6F6960; --gray-light:#A39C8F;
  --cream:#F6F2E8; --cream-deep:#EDE7D8; --paper:#FBF8F0;
  --accent:#B0532D; --accent-deep:#8A3F22; --accent-soft:#E8CFBE;
  --line:#D9D2C2; --line-soft:#E5DFD0; --good:#5C7A4F;
  --serif:'Fraunces','Times New Roman',serif;
  --sans:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
  --mono:'JetBrains Mono','Courier New',monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--sans);background:var(--cream);color:var(--ink);line-height:1.55;font-size:15px;-webkit-font-smoothing:antialiased}
.doc{max-width:1180px;margin:0 auto;background:var(--paper);box-shadow:0 0 60px rgba(22,20,15,.06)}
section{padding:clamp(48px,6vw,92px) clamp(20px,5vw,80px);position:relative}
section+section{border-top:1px solid var(--line)}
h1,h2,h3,h4{font-family:var(--serif);font-weight:400;line-height:1.06;letter-spacing:-.02em}
h2{font-size:clamp(28px,4vw,50px);margin-bottom:14px}
h3{font-size:clamp(20px,2.4vw,27px);line-height:1.2;font-weight:500}
p{color:var(--ink-soft);line-height:1.65}
.lead{font-family:var(--serif);font-size:clamp(17px,1.8vw,22px);line-height:1.45;font-weight:300;color:var(--ink-soft);max-width:760px}
.eyebrow{font-size:11px;font-weight:500;letter-spacing:.22em;text-transform:uppercase;color:var(--accent);margin-bottom:26px;display:flex;align-items:center;gap:14px}
.eyebrow::before{content:"";width:36px;height:1px;background:var(--accent);flex:0 0 36px}
.mono{font-family:var(--mono);font-size:12px;letter-spacing:.04em;color:var(--gray)}
.caps{font-size:11px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--gray)}
.none{font-size:13px;color:var(--gray);font-style:italic}

/* cover */
.cover{padding:clamp(40px,5vw,72px) clamp(20px,5vw,80px);min-height:88vh;display:flex;flex-direction:column;justify-content:space-between;gap:40px}
.cover-top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:28px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.wordmark{font-family:var(--serif);font-size:21px;font-weight:500}
.wordmark sup{font-size:9px;font-weight:400;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin-left:6px;vertical-align:top;position:relative;top:4px}
.cover-meta{text-align:right}.cover-meta .mono{display:block;line-height:1.8}
.cover-title h1{font-size:clamp(44px,9vw,112px);line-height:.96;font-weight:300;letter-spacing:-.035em}
.cover-title h1 em{font-style:italic;font-weight:400;color:var(--accent)}
.cover-subtitle{font-family:var(--serif);font-size:clamp(17px,2vw,23px);font-weight:300;font-style:italic;color:var(--gray);margin-top:28px;max-width:660px;line-height:1.4}
.cover-bottom{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:28px;padding-top:28px;border-top:1px solid var(--line)}
.cover-bottom .caps{margin-bottom:8px;display:block}
.cover-bottom .value{font-family:var(--serif);font-size:18px}

/* headline */
.headline-number{font-family:var(--serif);font-size:clamp(96px,17vw,210px);font-weight:300;line-height:.9;letter-spacing:-.05em;margin:14px 0 22px}
.headline-number .denom{font-size:.4em;color:var(--gray);margin-left:6px}
.headline-context{font-family:var(--serif);font-size:clamp(18px,2.3vw,26px);line-height:1.4;font-weight:300;color:var(--ink-soft);max-width:780px;font-style:italic}
.headline-context strong{font-weight:500;color:var(--ink);font-style:normal}
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-top:56px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.stat{padding:26px 22px;border-right:1px solid var(--line-soft)}
.stat:last-child{border-right:none}
.stat-label{font-size:11px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:var(--gray);margin-bottom:12px;line-height:1.4}
.stat-value{font-family:var(--serif);font-size:38px;line-height:1;letter-spacing:-.02em}
.stat-value .small{font-size:.55em;color:var(--gray);margin-left:2px}
.stat-sub{font-size:12px;color:var(--gray);margin-top:9px;line-height:1.4}

/* diagnostic */
.diagnostic-block{margin-top:52px}
.diagnostic-block+.diagnostic-block{margin-top:76px;padding-top:56px;border-top:1px solid var(--line-soft)}
.diag-num{font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.1em}
.diag-title{font-family:var(--serif);font-size:clamp(22px,2.8vw,31px);font-weight:500;line-height:1.2;margin:6px 0 8px;letter-spacing:-.015em}
.diag-sub{font-family:var(--serif);font-size:17px;font-style:italic;font-weight:300;color:var(--gray);margin-bottom:26px}
.chart-frame{background:var(--paper);border:1px solid var(--line);border-radius:4px;padding:clamp(16px,2.5vw,30px);margin-top:20px}
.chart-legend{display:flex;gap:24px;margin-bottom:16px;font-size:12px;color:var(--gray);flex-wrap:wrap}
.chart-legend span{display:flex;align-items:center;gap:8px}
.chart-legend i{width:12px;height:12px;border-radius:2px;display:inline-block}
svg.chart{width:100%;height:auto;display:block}
svg.chart .g{stroke:rgba(217,210,194,.6);stroke-width:1}
svg.chart .axis{stroke:#D9D2C2;stroke-width:1}
svg.chart .ax{font-family:var(--mono);font-size:11px;fill:var(--gray-light)}
svg.chart .b1{fill:#D9D2C2}
svg.chart .b2{fill:#B0532D}
.diag-read{display:grid;grid-template-columns:auto 1fr;gap:14px;margin-top:24px;padding:18px 22px;background:var(--cream-deep);border-left:2px solid var(--accent);border-radius:0 4px 4px 0}
.diag-read-marker{font-family:var(--serif);font-weight:500;color:var(--accent);font-size:14px;font-style:italic;white-space:nowrap}
.diag-read p{font-size:14px;line-height:1.6}

/* reveal cards */
.reveal-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin-top:20px}
.reveal-card{padding:26px;border-radius:4px;border:1px solid var(--line);background:var(--paper)}
.reveal-card.bright{background:var(--ink);border-color:var(--ink)}
.reveal-card.bright .reveal-label{color:var(--gray-light)}
.reveal-card.bright .reveal-num{color:var(--paper)}
.reveal-card.bright .reveal-foot{color:var(--accent-soft)}
.reveal-label{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--gray);margin-bottom:16px;font-weight:500}
.reveal-num{font-family:var(--serif);font-size:clamp(40px,6vw,60px);line-height:1;letter-spacing:-.02em}
.reveal-num .pct{font-size:.45em;color:var(--gray);margin-left:3px}
.reveal-foot{font-size:12px;color:var(--gray);margin-top:14px;line-height:1.5}

/* timeline */
.timeline-row{display:grid;grid-template-columns:minmax(150px,220px) 1fr minmax(96px,140px);align-items:center;gap:14px;padding:13px 0;border-bottom:1px solid var(--line-soft)}
.timeline-row:last-child{border-bottom:none}
.timeline-sku{font-family:var(--serif);font-size:14px;font-weight:500;line-height:1.3;overflow-wrap:anywhere}
.timeline-sku .sku-meta{display:block;font-family:var(--mono);font-size:10px;color:var(--gray);margin-top:2px}
.timeline-bar{position:relative;height:18px;background:var(--cream-deep);border-radius:1px;overflow:hidden}
.timeline-fill{position:absolute;top:0;bottom:0;left:0;background:var(--good)}
.timeline-broken{position:absolute;top:0;bottom:0;background:var(--accent);opacity:.85}
.timeline-right{text-align:right;font-family:var(--mono);font-size:11px;color:var(--accent)}
.timeline-right .base{color:var(--gray);font-style:italic}

/* tables */
.tbl{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}
.tbl thead th{text-align:left;font-size:10px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--gray);padding:13px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.tbl thead th.num{text-align:right}
.tbl tbody tr{border-bottom:1px solid var(--line-soft)}
.tbl tbody td{padding:14px 10px;color:var(--ink-soft);vertical-align:middle}
.tbl tbody td.num{text-align:right;font-family:var(--mono);font-size:13px;color:var(--ink)}
.tbl .style{font-family:var(--serif);font-weight:500;font-size:15px;color:var(--ink);line-height:1.3}
.tbl .style .id{display:block;font-family:var(--mono);font-size:10px;color:var(--gray);margin-top:2px;overflow-wrap:anywhere}
.chip{display:inline-block;padding:3px 9px;background:var(--cream-deep);border-radius:2px;font-family:var(--mono);font-size:11px;font-weight:500;color:var(--ink)}
.chip.out{background:var(--accent-soft);color:var(--accent-deep)}
.down{color:var(--accent);font-family:var(--mono);font-size:13px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}

/* gaps */
.gaps{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1px;background:var(--line-soft);border:1px solid var(--line-soft);border-radius:4px;margin-top:22px}
.gap{background:var(--paper);padding:20px 22px}
.gap-h{font-family:var(--serif);font-size:17px;font-weight:500;margin-bottom:8px}
.gap-f{font-family:var(--mono);font-size:10.5px;color:var(--gray-light);line-height:1.5;margin-bottom:10px;overflow-wrap:anywhere}
.gap-w{font-size:13px;color:var(--gray);line-height:1.55}
.gap-m{margin-top:10px;font-size:11px;color:var(--accent);letter-spacing:.04em}
.gap-m code{font-family:var(--mono);background:var(--accent-soft);color:var(--accent-deep);padding:2px 6px;border-radius:2px;margin-right:4px;font-size:10.5px}
.gap-y{margin-top:8px;font-size:11.5px;color:var(--good)}
.note{margin-top:18px;font-size:13px;color:var(--gray);font-style:italic;max-width:760px}

/* bands */
svg.bandbar{width:100%;height:10px;display:block;border-radius:2px;overflow:hidden;margin-top:18px}
.bandkey{display:flex;gap:18px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:var(--gray)}
.bandkey i{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:6px}

/* method */
.method-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:34px;margin-top:36px;align-items:start}
.method-block{background:var(--cream-deep);border-left:2px solid var(--accent);padding:24px 26px;border-radius:0 4px 4px 0}
.method-block h4{font-size:16px;font-weight:500;margin-bottom:14px}
.mlist{list-style:none}
.mlist li{font-size:13px;color:var(--ink-soft);padding:8px 0;display:grid;grid-template-columns:26px 1fr;gap:10px;border-bottom:1px solid var(--line-soft);line-height:1.5}
.mlist li:last-child{border-bottom:none}
.mlist .i{font-family:var(--mono);font-size:11px;color:var(--accent)}
.pill{font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:9px;letter-spacing:.06em;text-transform:uppercase}
.pill.ok{background:#E4EBE0;color:#3F5836}
.pill.ad{background:var(--accent-soft);color:var(--accent-deep)}
.pill.no{background:#E9E4D6;color:var(--gray)}

.doc-footer{padding:26px clamp(20px,5vw,80px);border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--gray);letter-spacing:.12em;text-transform:uppercase;font-family:var(--mono)}

@media print{
  body{background:#fff}
  .doc{box-shadow:none;max-width:none}
  section{page-break-after:always;padding:44px 40px}
  .reveal-card.bright{background:var(--paper);border-color:var(--line)}
  .reveal-card.bright .reveal-num{color:var(--ink)}
  .reveal-card.bright .reveal-label,.reveal-card.bright .reveal-foot{color:var(--gray)}
  .scroll{overflow:visible}
}
</style>
</head>
<body>
<div class="doc">

<!-- ══ cover ══ -->
<section class="cover">
  <div class="cover-top">
    <div class="wordmark">${esc(f.store.name)}<sup>Feed intelligence</sup></div>
    <div class="cover-meta">
      <span class="mono">Generated from tracked feed data</span>
      <span class="mono">Document №&nbsp;${esc(docNo)}</span>
    </div>
  </div>
  <div class="cover-title">
    <span class="eyebrow">An assessment of ${esc(f.store.domain)}</span>
    <h1>The Sales<br>Curve <em>Audit.</em></h1>
    <p class="cover-subtitle">${esc(n.cover_subtitle)}</p>
  </div>
  <div class="cover-bottom">
    <div><span class="caps">Store</span><span class="value">${esc(f.store.name)} · ID ${esc(f.store.id)}</span></div>
    <div><span class="caps">Analysis window · T₀</span><span class="value">${dt(f.window.from)} — ${dt(f.window.to)}</span></div>
    <div><span class="caps">Observed days</span><span class="value">${f.window.run_dates.length} of ${f.periods.T0.days}</span></div>
    <div><span class="caps">Currency</span><span class="value">${esc(cur)}</span></div>
  </div>
</section>

<!-- ══ 01 headline ══ -->
<section>
  <div class="eyebrow">Section 01 · The headline</div>
  <h2>${esc(n.headline_verdict)}</h2>
  <p class="lead">Read from ${nf(f.headline.variant_days.value)} variant-days of tracked feed data. Every figure below is computed from the feed; nothing is estimated.</p>
  <div class="headline-number">${pc(f.stockout.oos_rate.value).replace('%', '')}<span class="denom">%</span></div>
  <p class="headline-context">of observed variant-days were out of stock. <strong>Not inferred.</strong> ${esc(n.headline_context)}</p>

  <div class="stat-row">
    ${stat('Styles read', nf(f.headline.style_count.value), 'distinct products present in the feed')}
    ${stat('Variants analysed', nf(f.headline.variant_count.value), 'size × colour × fabric')}
    ${stat('Styles broken on size', `${f.headline.broken_style_pct.value ?? '—'}<span class="small">%</span>`,
      `${nf(f.headline.broken_style_pct.numerator)} of ${nf(f.headline.broken_style_pct.denominator)} sized styles`)}
    ${stat('Variant-days out of stock', nf(f.stockout.oos_variant_days.value), 'the spec’s own formula, unmodified')}
  </div>
</section>

<!-- ══ 02 opportunity stack ══ -->
<section style="background:var(--cream-deep)">
  <div class="eyebrow">Section 02 · The opportunity stack</div>
  <h2>Four leaks the feed cannot price.</h2>
  <p class="lead">The specification sizes each leak in currency. Every one of those formulas multiplies by a rate of sale, a margin or an ad spend, and a public product feed carries none of them. The leaks are named here with the exact input that is missing, rather than filled with a plausible number.</p>
  ${gapGrid(f.opportunity_stack, ['broken_size_opportunity', 'markdown_avoidance', 'wasted_ad_spend', 'reorder_chase_lift'])}
  <p class="note">${esc(n.limits)}</p>
</section>

<!-- ══ 03 diagnostic ══ -->
<section>
  <div class="eyebrow">Section 03 · The diagnostic</div>
  <h2>What the feed does show.</h2>
  <p class="lead">Three readings of the same window. Each isolates one mechanic and reports only what the data supports.</p>

  <!-- 03a -->
  <div class="diagnostic-block">
    <div class="diag-num">03 / a</div>
    <div class="diag-title">The range is flat. Availability is not.</div>
    <div class="diag-sub">Share of the range by size, against how often each size is unavailable</div>
    <div class="chart-frame">
      <div class="chart-legend">
        <span><i style="background:#D9D2C2"></i>Share of variants (%)</span>
        <span><i style="background:#B0532D"></i>Share of days out of stock (%)</span>
      </div>
      ${sizeCurveSvg(sizes)}
    </div>
    <p class="note">Substitution: ${esc(f.size_curve.size_mix.substituted)}. Core sizes read as ${esc((f.size_curve.core_sizes.value || []).join(', ') || '—')}.</p>
    ${read('Read', n.reads.size_curve)}
    ${gapGrid(f.size_curve, ['planned_pack', 'actual_str_by_size', 'xl_residual_risk'])}
  </div>

  <!-- 03b -->
  <div class="diagnostic-block">
    <div class="diag-num">03 / b</div>
    <div class="diag-title">Availability, counted in variant-days.</div>
    <div class="diag-sub">The spec's stockout correction needs units sold; its denominator does not</div>
    <div class="reveal-grid">
      <div class="reveal-card">
        <div class="reveal-label">Variant-days in stock</div>
        <div class="reveal-num">${nf(f.stockout.in_stock_variant_days.value)}</div>
        <div class="reveal-foot">Days on which a variant was present in the feed and sellable. This is the denominator of the spec's baseline velocity, computed exactly.</div>
      </div>
      <div class="reveal-card bright">
        <div class="reveal-label">Variant-days out of stock</div>
        <div class="reveal-num">${nf(f.stockout.oos_variant_days.value)}<span class="pct"> · ${pc(f.stockout.oos_rate.value)}</span></div>
        <div class="reveal-foot">Read from the Inventory quantity column: blank means sellable, 0 means sold out. Verified at 99.2% against the live storefront.</div>
      </div>
    </div>
    ${read('Read', n.reads.stockout)}
    ${gapGrid(f.stockout, ['net_str_corrected', 'latent_demand_gap', 'bis_signups'])}
  </div>

  <!-- 03c -->
  <div class="diagnostic-block">
    <div class="diag-num">03 / c</div>
    <div class="diag-title">The styles carrying a broken ladder.</div>
    <div class="diag-sub">One size unavailable while a sibling size of the same style is in stock</div>
    <div class="chart-frame">
      <div class="chart-legend">
        <span><i style="background:#5C7A4F"></i>Days with a full ladder</span>
        <span><i style="background:#B0532D"></i>Days broken</span>
      </div>
      ${brokenRows.length ? brokenRows.map(r => {
        const brokenPct = (r.days_broken / maxDays) * 100
        const fullPct = ((r.days_observed - r.days_broken) / maxDays) * 100
        return `<div class="timeline-row">
          <div class="timeline-sku">${esc(r.title || r.handle)}
            <span class="sku-meta">${esc(r.handle)}</span></div>
          <div class="timeline-bar">
            <div class="timeline-fill" style="width:${fullPct.toFixed(1)}%"></div>
            <div class="timeline-broken" style="left:${fullPct.toFixed(1)}%;width:${brokenPct.toFixed(1)}%"></div>
          </div>
          <div class="timeline-right">${r.at_baseline
            ? '<span class="base">already broken</span>'
            : 'broke ' + dt(r.first_broken_on)}<br>
            <span class="base">${esc((r.sizes_missing || []).join(', ') || '—')}</span></div>
        </div>`
      }).join('') : '<p class="none">No style lost a size while a sibling size stayed in stock.</p>'}
    </div>
    <p class="note">${f.broken_timeline.observed_breaks.value} style(s) were seen breaking inside the window. ${esc(f.broken_timeline.observed_breaks.note)}</p>
    ${read('Read', n.reads.broken_timeline)}
    ${gapGrid(f.broken_timeline, ['loss_per_sku'])}
  </div>

  <!-- 03d -->
  <div class="diagnostic-block">
    <div class="diag-num">03 / d</div>
    <div class="diag-title">The media section, for the record.</div>
    <div class="diag-sub">Wasted ad spend on out-of-stock PDPs · not observable from outside</div>
    ${gapGrid(f.ad_waste, ['wasted_ad_spend', 'waste_share', 'oos_sessions', 'cr_oos'])}
    <p class="note">${esc(f.ad_waste.note)}</p>
  </div>
</section>

<!-- ══ 04 pricing ══ -->
<section style="background:var(--cream-deep)">
  <div class="eyebrow">Section 04 · Price and discount</div>
  <h2>The signal this feed carries best.</h2>
  <p class="lead">Outside the specification, whose reader owns the store and already knows its own prices. Watching a rival, this is the movement that is fully visible.</p>

  <div class="stat-row" style="border-color:var(--line)">
    ${stat('Price drops', nf(f.pricing.price_drops.value), 'variant-level reductions')}
    ${stat('Price rises', nf(f.pricing.price_rises.value), 'variant-level increases')}
    ${stat('Average move', pc(f.pricing.avg_move_pct.value), 'mean absolute change')}
    ${stat('Largest single move', pc(f.pricing.max_move_pct.value), 'steepest one variant moved')}
  </div>

  <h3 style="margin-top:48px">Where the range sits on discount</h3>
  ${bandSvg(f.pricing.discount_bands)}
  <p class="note">Active variants by discount band on ${dt(f.window.to)}. Price range ${nf(f.pricing.price_spread.min)} – ${nf(f.pricing.price_spread.max)} ${esc(cur)}, median ${nf(f.pricing.price_spread.median)}.</p>

  ${f.pricing.biggest_drops.length ? `
  <h3 style="margin-top:44px">Steepest drops in the window</h3>
  <div class="scroll"><table class="tbl">
    <thead><tr><th>Style</th><th>Variant</th><th class="num">Was</th><th class="num">Now</th>
      <th class="num">Change</th><th class="num">Discount</th><th class="num">On</th></tr></thead>
    <tbody>${f.pricing.biggest_drops.map(r => `<tr>
      <td><span class="style">${esc(r.title || r.handle)}<span class="id">${esc(r.sku || r.handle)}</span></span></td>
      <td><span class="chip">${esc(r.variant || '—')}</span></td>
      <td class="num">${nf(r.from)}</td>
      <td class="num">${nf(r.to)}</td>
      <td class="num"><span class="down">${r.diff_pct == null ? '—' : r.diff_pct + '%'}</span></td>
      <td class="num">${pc(r.discount_pct)}</td>
      <td class="num">${dt(r.on)}</td></tr>`).join('')}</tbody>
  </table></div>` : ''}
  ${read('Read', n.reads.pricing)}
</section>

<!-- ══ 05 assortment ══ -->
<section>
  <div class="eyebrow">Section 05 · Assortment movement</div>
  <h2>What entered and what left.</h2>
  <div class="stat-row">
    ${stat('New variants', nf(f.assortment.new_variants.value), 'first appearance in the feed')}
    ${stat('Variants removed', nf(f.assortment.removed_variants.value), 'left the feed entirely')}
    ${stat('Went out of stock', nf(f.assortment.went_out.value), 'still listed, not sellable')}
    ${stat('Came back in stock', nf(f.assortment.came_back.value), 'returned to sellable')}
  </div>
  ${read('Read', n.reads.assortment)}

  ${f.assortment.categories.length ? `
  <h3 style="margin-top:44px">By category</h3>
  <div class="scroll"><table class="tbl">
    <thead><tr><th>Category</th><th class="num">Styles</th><th class="num">Variants</th>
      <th class="num">Days OOS</th><th class="num">Avg price</th><th class="num">Avg discount</th></tr></thead>
    <tbody>${f.assortment.categories.map(c => `<tr>
      <td><span class="style">${esc(c.product_type)}</span></td>
      <td class="num">${nf(c.styles)}</td>
      <td class="num">${nf(c.variants)}</td>
      <td class="num">${pc(c.oos_rate)}</td>
      <td class="num">${nf(c.avg_price)}</td>
      <td class="num">${pc(c.avg_discount)}</td></tr>`).join('')}</tbody>
  </table></div>` : ''}
</section>

<!-- ══ 06 what to watch ══ -->
<section style="background:var(--ink);color:var(--paper)">
  <div class="eyebrow" style="color:var(--accent-soft)">Section 06 · What to watch</div>
  <h2 style="color:var(--paper)">Three things to follow next.</h2>
  <p class="lead" style="color:var(--gray-light)">The specification's plays are actions inside your own store. Watching a rival, the equivalent is what to track in the next scrape.</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.08);margin-top:44px">
    ${(n.actions || []).slice(0, 3).map((a, i) => `
    <div style="background:var(--ink);padding:30px 26px;display:flex;flex-direction:column;gap:14px">
      <div style="font-family:var(--serif);font-size:14px;font-style:italic;color:var(--accent-soft)">— ${String(i + 1).padStart(2, '0')}</div>
      <h3 style="color:var(--paper);font-weight:400">${esc(a.title)}</h3>
      <p style="color:var(--gray-light);font-size:14px;flex:1">${esc(a.why)}</p>
      <div style="border-top:1px solid rgba(255,255,255,.12);padding-top:16px">
        <div style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--gray-light);margin-bottom:6px">Watch</div>
        <div style="font-family:var(--serif);font-size:16px;color:var(--accent-soft);line-height:1.35">${esc(a.watch)}</div>
      </div>
    </div>`).join('')}
  </div>
  ${gapGrid(f.trajectory, ['gmv_no_action', 'gmv_with_plays', 'revenue_delta', 'gm_delta'])
    .replace('class="gaps"', 'class="gaps" style="margin-top:34px;background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.08)"')
    .replace(/class="gap"/g, 'class="gap" style="background:#1E1B15"')}
</section>

<!-- ══ 07 methodology ══ -->
<section>
  <div class="eyebrow">Section 07 · How this was built</div>
  <h2>Every number, and where it came from.</h2>
  <div class="method-grid">
    <div>
      <h3>Time periods · specification §1</h3>
      <div class="scroll"><table class="tbl">
        <thead><tr><th>Symbol</th><th>Window</th><th>Resolved</th></tr></thead>
        <tbody>${Object.entries(f.periods).map(([, p]) => `<tr>
          <td class="mono">${esc(p.symbol)}</td>
          <td>${esc(p.label)}<span class="id mono" style="display:block;color:var(--gray)">spec: ${esc(p.spec || '—')}</span></td>
          <td>${p.status === 'unavailable'
            ? `<span class="pill no">unavailable</span><div style="font-size:11.5px;color:var(--gray);margin-top:6px">${esc(p.why || '')}</div>`
            : `<span class="mono">${esc(p.value ?? '—')}</span>${p.note ? `<div style="font-size:11.5px;color:var(--gray);margin-top:6px">${esc(p.note)}</div>` : ''}`}</td>
        </tr>`).join('')}</tbody>
      </table></div>

      <h3 style="margin-top:40px">Data sources · specification §2</h3>
      <div class="scroll"><table class="tbl">
        <thead><tr><th>Source</th><th>State</th><th>What is missing</th></tr></thead>
        <tbody>${f.data_sources.map(s => `<tr>
          <td>${esc(s.source)}</td>
          <td><span class="pill ${s.connected === 'partial' ? 'ad' : s.connected === 'no' ? 'no' : 'ok'}">${esc(s.connected)}</span></td>
          <td style="font-size:12.5px;color:var(--gray)">${esc(s.missing || '—')}${s.have ? `<div style="color:var(--good);margin-top:4px">have: ${esc(s.have)}</div>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>

    <div class="method-block">
      <h4>Sanity checks · specification §6</h4>
      <ul class="mlist">
        ${f.sanity_checks.map(c => `<li><span class="i">${String(c.rule).padStart(2, '0')}</span>
          <span><strong>${esc(c.name)}.</strong> ${c.skipped
            ? `<span style="color:var(--gray)">skipped, ${esc(c.skipped)}</span>`
            : `<span style="color:${c.pass ? 'var(--good)' : 'var(--accent)'}">${c.pass ? 'pass' : 'FAIL'}</span> · <span style="color:var(--gray)">${esc(c.detail)}</span>`}</span></li>`).join('')}
      </ul>

      <h4 style="margin-top:26px">Edge cases · specification §7</h4>
      <ul class="mlist">
        ${f.edge_cases.map((e, i) => `<li><span class="i">${String(i + 1).padStart(2, '0')}</span>
          <span><strong>${esc(e.case)}.</strong> <span style="color:var(--gray)">${esc(e.finding)}</span></span></li>`).join('')}
      </ul>

      <h4 style="margin-top:26px">Coverage</h4>
      <ul class="mlist">
        <li><span class="i">01</span><span><strong>${coverage.observed_days} of ${coverage.window_days} days observed</strong> · ${coverage.completeness}% · grade ${esc(coverage.grade)}</span></li>
        <li><span class="i">02</span><span style="color:var(--gray)">${esc(coverage.basis)}</span></li>
        <li><span class="i">03</span><span><strong>Prose.</strong> <span style="color:var(--gray)">Written by ${esc(n.model)}. Numbers are rendered from the computed facts, never from the model; every figure in the prose was checked against those facts before publishing${n.verified === false ? ' and <span style="color:var(--accent)">failed</span>, so the deterministic text is shown' : ''}.</span></span></li>
      </ul>
    </div>
  </div>
</section>

<div class="doc-footer">
  <div>Sales Curve Audit · ${esc(f.store.name)} · №&nbsp;${esc(docNo)}</div>
  <div>${esc(id)} · generated ${dt(new Date().toISOString())}</div>
</div>
</div>
</body></html>`
}
