/**
 * The audit's prose, written by OpenAI.
 *
 * The model gets the computed facts and writes only the reading of them. It is
 * never asked for a number: every figure in the report is rendered from the
 * facts object by the template, and the prompt forbids introducing any other.
 * That split is the whole reason the report can be trusted — a model asked to
 * "produce an audit" will happily invent a plausible dollar figure.
 *
 * If no key is set, or the call fails, a deterministic fallback is written from
 * the same facts so the report still generates. It reads plainer; it is never
 * wrong.
 */

const API = 'https://api.openai.com/v1/chat/completions'

const SYSTEM = `You are a senior fashion category planner writing the prose of a
competitive intelligence audit.

WHO IS READING. The reader is an analyst watching a rival retailer from the
outside. They do NOT own this store, cannot change its prices, cannot reorder
its stock and cannot see its sales. Never write advice addressed to the store.
"Reduce your out-of-stocks" or "improve replenishment" is wrong: the reader has
no such lever. Everything you recommend must be something the reader can do
with this intelligence, such as what to watch next, where the rival is exposed,
or what its behaviour reveals about its plan.

WHAT YOU ARE GIVEN. A JSON object of facts computed from a daily product-feed
scrape. Absolute rules:
1. Every number you write MUST appear verbatim in the facts JSON. Never
   compute, derive, sum, average or re-round a figure. This is checked
   automatically after you answer, and an unsupported number fails the audit.
2. Never write a currency amount. There is no sales, revenue, margin, ad spend
   or unit-count data. "Lost revenue" cannot be said at all.
3. Read a figure only as what it is. A discount on one listed variant is that
   variant's discount, not the store's deepest discount. A per-size
   out-of-stock rate is not a sell-through rate.
4. Where a fact is marked "adapted", respect the substitution named inside it.
   Where a variable is "unavailable", do not work around it.
5. Do not speculate about the rival's internal decisions, suppliers or
   intentions beyond what the feed shows.
6. Short declarative sentences. Specific. No marketing language, no hedging.
   British spelling. Never use em dashes.

The headline verdict must contain a specific figure from the facts and name the
thing it is about. "Out-of-stocks are a problem" is a failure.

Return JSON only, matching the requested shape exactly.`

const SHAPE = `{
  "cover_subtitle": "one sentence, max 30 words, naming the window and the single biggest observation",
  "headline_verdict": "one short sentence: the most important thing this feed shows",
  "headline_context": "two sentences expanding the verdict, citing figures from the facts",
  "reads": {
    "size_curve": "2-3 sentences reading the assortment-vs-scarcity comparison",
    "stockout": "2-3 sentences reading the out-of-stock exposure",
    "broken_timeline": "2-3 sentences reading which styles lost sizes",
    "pricing": "2-3 sentences reading the price and discount movement",
    "assortment": "2 sentences reading what entered and left the range"
  },
  "actions": [
    {"title": "short imperative addressed to the analyst, not the rival store",
     "why": "one sentence grounded in a cited figure",
     "watch": "the specific thing to look for in the next scrape"}
  ],
  "limits": "two sentences naming what this audit cannot say and which data source would be needed"
}`

/* ── trim the facts to what the model needs to read ───────────────── */

const val = f => (f && f.status !== 'unavailable' ? f.value : null)

function payload (facts) {
  const sc = facts.size_curve
  return {
    store: facts.store,
    window: { from: facts.window.from, to: facts.window.to,
              observed_days: facts.window.run_dates.length,
              note: facts.periods.T0.note },
    counts: {
      styles: val(facts.headline.style_count),
      variants: val(facts.headline.variant_count),
      variant_days: val(facts.headline.variant_days)
    },
    stockout: {
      oos_variant_days: val(facts.stockout.oos_variant_days),
      in_stock_variant_days: val(facts.stockout.in_stock_variant_days),
      oos_rate_pct: val(facts.stockout.oos_rate)
    },
    broken: {
      styles_broken_pct: val(facts.headline.broken_style_pct),
      broken_styles: facts.headline.broken_style_pct.numerator,
      sized_styles: facts.headline.broken_style_pct.denominator,
      seen_breaking_in_window: val(facts.broken_timeline.observed_breaks),
      rows: facts.broken_timeline.rows.slice(0, 8).map(r => ({
        handle: r.handle, title: r.title, type: r.product_type,
        at_baseline: r.at_baseline, first_broken_on: r.first_broken_on,
        days_broken: r.days_broken, days_observed: r.days_observed,
        sizes_missing: r.sizes_missing
      })),
      selection_caveat: sc && facts.broken_timeline.selection.substituted
    },
    size_curve: {
      core_sizes: val(sc.core_sizes),
      substitution: sc.size_mix.substituted,
      rows: sc.size_mix.rows.slice(0, 12),
      scarcest: sc.first_to_break.rows.slice(0, 6)
    },
    pricing: {
      // Named so a field cannot be mistaken for a neighbouring one: a single
      // variant's discount is not the store's deepest discount, and the average
      // move is not a drop. The numeric check cannot catch a mislabelled figure,
      // only an invented one, so the labels have to carry their own scope.
      count_of_price_drops: val(facts.pricing.price_drops),
      count_of_price_rises: val(facts.pricing.price_rises),
      count_of_discount_only_changes: val(facts.pricing.discount_moves),
      average_price_move_pct_across_all_changes: val(facts.pricing.avg_move_pct),
      largest_single_price_move_pct: val(facts.pricing.max_move_pct),
      price_spread_current_day: facts.pricing.price_spread,
      variants_per_discount_band_current_day: facts.pricing.discount_bands,
      ten_individual_variants_with_the_steepest_drops:
        facts.pricing.biggest_drops.slice(0, 6).map(r => ({
          title: r.title, variant: r.variant,
          price_before: r.from, price_after: r.to,
          this_variants_price_change_pct: r.diff_pct,
          this_variants_discount_after_the_drop_pct: r.discount_pct,
          on: r.on
        }))
    },
    assortment: {
      new_variants: val(facts.assortment.new_variants),
      removed_variants: val(facts.assortment.removed_variants),
      went_out: val(facts.assortment.went_out),
      came_back_while_still_listed: val(facts.assortment.came_back),
      put_back_on_the_feed_after_being_removed: val(facts.assortment.relisted),
      categories: facts.assortment.categories.slice(0, 6)
    },
    unavailable: Object.entries({
      ...facts.opportunity_stack, ...facts.ad_waste, ...facts.trajectory
    }).filter(([, v]) => v && v.status === 'unavailable')
      .map(([k, v]) => ({ variable: k, missing: v.missing })),
    coverage: facts.confidence.coverage
  }
}

/* ── numeric verification ─────────────────────────────────────────── */

/** Every number that appears anywhere in the facts, as normalised strings. */
function allowedNumbers (obj, into = new Set()) {
  const add = v => {
    if (v == null) return
    const s = String(v)
    for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) {
      into.add(m[0])
      // a figure the template prints as 1,564 is the same fact as 1564
      if (m[0].includes('.')) into.add(String(Number(m[0])))
    }
  }
  if (obj == null) return into
  if (typeof obj !== 'object') { add(obj); return into }
  for (const v of Object.values(obj)) allowedNumbers(v, into)
  return into
}

/**
 * Numbers the prose may use without appearing in the facts: small counts a
 * sentence needs for its own grammar ("three styles", "two sizes"). Anything
 * larger, and anything with a decimal, has to be a fact.
 */
const isFreeSmallCount = s => !s.includes('.') && Number(s) <= 12

function unsupportedNumbers (narrative, allowed) {
  const text = [
    narrative.cover_subtitle, narrative.headline_verdict, narrative.headline_context,
    ...Object.values(narrative.reads || {}),
    ...(narrative.actions || []).flatMap(a => [a.title, a.why, a.watch]),
    narrative.limits
  ].filter(Boolean).join(' \n ')

  const bad = new Set()
  for (const m of text.replace(/,(?=\d{3}\b)/g, '').matchAll(/\d+(?:\.\d+)?/g)) {
    const n = m[0]
    if (allowed.has(n) || allowed.has(String(Number(n))) || isFreeSmallCount(n)) continue
    bad.add(n)
  }
  return [...bad]
}

/* ── the call ─────────────────────────────────────────────────────── */

async function callOpenAI ({ key, model, facts, signal, complaint }) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content:
`Facts:
${JSON.stringify(payload(facts), null, 1)}

Write the audit prose for ${facts.store.name} (${facts.store.domain}).
Give exactly three actions.
Return JSON of this shape:
${SHAPE}` }
  ]
  if (complaint) messages.push({ role: 'user', content: complaint })

  const res = await fetch(API, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, temperature: 0.4,
      response_format: { type: 'json_object' }, messages
    })
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 300)}`)
  }
  const json = await res.json()
  const text = json.choices?.[0]?.message?.content
  if (!text) throw new Error('OpenAI returned no content')
  return { n: JSON.parse(text), usage: json.usage }
}

/**
 * budgetMs bounds the whole thing, because this runs inside a serverless
 * function with a hard ceiling. Two model calls at their slowest exceeded it and
 * the request died with nothing to show; a deterministic narrative delivered on
 * time beats a better one that never arrives.
 */
export async function writeNarrative (facts, { signal, budgetMs = 40000 } = {}) {
  const key = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL || 'gpt-4o'
  const base = fallback(facts)
  if (!key) return { ...base, model: 'fallback (no OPENAI_API_KEY set)', verified: true }

  const started = Date.now()
  const left = () => budgetMs - (Date.now() - started)
  const deadline = () => {
    const t = AbortSignal.timeout(Math.max(4000, left()))
    return signal ? AbortSignal.any([signal, t]) : t
  }

  const allowed = allowedNumbers(payload(facts))
  let tokensIn = 0, tokensOut = 0

  try {
    let { n, usage } = await callOpenAI({ key, model, facts, signal: deadline() })
    tokensIn += usage?.prompt_tokens ?? 0
    tokensOut += usage?.completion_tokens ?? 0
    let bad = unsupportedNumbers(n, allowed)

    // One correction round. A model that invents a figure will usually drop it
    // when the specific digits are quoted back at it — but only if there is time
    // left to ask. Out of budget, the deterministic text stands in instead.
    if (bad.length && left() > 14000) {
      const retry = await callOpenAI({
        key, model, facts, signal: deadline(),
        complaint:
          `These numbers appeared in your answer but are not in the facts: ${bad.join(', ')}. ` +
          `Rewrite the whole JSON using only numbers present in the facts. If a sentence ` +
          `needs a figure you do not have, drop the sentence rather than inventing one.`
      })
      tokensIn += retry.usage?.prompt_tokens ?? 0
      tokensOut += retry.usage?.completion_tokens ?? 0
      const retryBad = unsupportedNumbers(retry.n, allowed)
      if (retryBad.length < bad.length) { n = retry.n; bad = retryBad }
    }

    // Still fabricating after being told twice: the prose is not trustworthy,
    // so ship the deterministic version rather than a pretty wrong one.
    if (bad.length) {
      return { ...base, model: `fallback (unsupported figures: ${bad.join(', ')})`,
               verified: false, prompt_tokens: tokensIn, output_tokens: tokensOut }
    }

    return {
      ...base,                      // guarantees every field exists
      ...n,
      reads: { ...base.reads, ...(n.reads || {}) },
      model, verified: true,
      prompt_tokens: tokensIn, output_tokens: tokensOut
    }
  } catch (err) {
    return { ...base, model: `fallback (${err.message})`, verified: true,
             prompt_tokens: tokensIn, output_tokens: tokensOut }
  }
}

/* ── deterministic fallback ───────────────────────────────────────── */

function fallback (facts) {
  const s = facts.store
  const oos = facts.stockout
  const bp = facts.headline.broken_style_pct
  const sizes = facts.size_curve.size_mix.rows
  const worst = [...sizes].sort((a, b) => (b.oos_rate ?? 0) - (a.oos_rate ?? 0))[0]
  const best  = [...sizes].sort((a, b) => (a.oos_rate ?? 0) - (b.oos_rate ?? 0))[0]
  const days = facts.window.run_dates.length
  const p = facts.pricing

  return {
    cover_subtitle:
      `A reading of ${days} observed day(s) of ${s.name}'s public feed, ` +
      `${facts.headline.style_count.value} styles and ${facts.headline.variant_count.value} variants, ` +
      `and where its size ladder is breaking.`,
    headline_verdict:
      `${oos.oos_rate.value}% of observed variant-days were out of stock.`,
    headline_context:
      `Across ${facts.headline.variant_days.value} variant-days, ${oos.oos_variant_days.value} were not sellable. ` +
      `${bp.numerator} of ${bp.denominator} sized styles lost at least one size while a sibling size stayed in stock.`,
    reads: {
      size_curve: worst && best
        ? `The range is spread close to evenly across sizes, but availability is not. ` +
          `Size ${worst.size} is out on ${worst.oos_rate}% of its observed days against ` +
          `${best.oos_rate}% for size ${best.size}. Sell-through by size needs order data and is not available here.`
        : 'No size option was found on this feed, so no size curve can be read.',
      stockout:
        `${oos.oos_variant_days.value} of ${facts.headline.variant_days.value} variant-days were out of stock. ` +
        `The stockout-corrected sell-through the spec asks for needs units sold, which a public feed does not carry.`,
      broken_timeline:
        `${facts.broken_timeline.observed_breaks.value} style(s) were seen losing a size inside the window. ` +
        `The rest were already broken on the first observed day, so they have no observable break date.`,
      pricing: p.price_drops.value || p.price_rises.value
        ? `${p.price_drops.value} price drops and ${p.price_rises.value} rises were recorded, ` +
          `averaging ${p.avg_move_pct.value}% and reaching ${p.max_move_pct.value}% at the extreme.`
        : 'No price movement was recorded in this window.',
      assortment:
        `${facts.assortment.new_variants.value} variants entered the range and ` +
        `${facts.assortment.removed_variants.value} left it. ` +
        `${facts.assortment.went_out.value} went out of stock and ${facts.assortment.came_back.value} returned.`
    },
    actions: [
      { title: 'Watch the sizes that empty first',
        why: worst ? `Size ${worst.size} is unavailable on ${worst.oos_rate}% of its observed days.` : 'Size-level availability varies across the range.',
        watch: 'whether the same sizes stay scarce as new drops land' },
      { title: 'Track the styles that lost a size',
        why: `${bp.numerator} sized styles are carrying a broken ladder.`,
        watch: 'whether the missing sizes come back or the style is left broken' },
      { title: 'Follow the discount ladder',
        why: p.price_drops.value ? `${p.price_drops.value} price drops landed in this window.` : 'Prices held flat in this window.',
        watch: 'how deep the next markdown goes and which categories move first' }
    ],
    limits:
      'This audit reads a public product feed, so it carries no sales, returns, margin, ad spend or unit counts. ' +
      'The spec\'s monetary opportunity figures would need order-level data from inside the store.'
  }
}
