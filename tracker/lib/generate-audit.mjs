/**
 * Generate one store's audit and store it.
 *
 * Shared by the API route and the CLI so both produce byte-identical reports.
 * The facts are kept alongside the HTML: a figure in a report read six months
 * from now must be explainable without re-running the engine against data that
 * has moved on.
 */
import { q, one } from './db.mjs'
import { buildFacts } from './audit.mjs'
import { writeNarrative } from './narrative.mjs'
import { renderReport } from './report-html.mjs'

/** Short, url-safe, no ambiguous characters. */
function token (n = 6) {
  const A = '23456789abcdefghijkmnpqrstuvwxyz'
  let s = ''
  for (const b of crypto.getRandomValues(new Uint8Array(n))) s += A[b % A.length]
  return s
}

const slug = s => String(s).toLowerCase()
  .normalize('NFKD').replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 44)

export async function generateAudit ({ storeId, from, to, signal }) {
  const started = Date.now()

  const r = await one(
    `SELECT MIN(run_date) AS f, MAX(run_date) AS t FROM scrape_runs
      WHERE store_id = $1 AND status IN ('success','partial')`, [storeId])
  const f0 = from || (r?.f && String(r.f).slice(0, 10))
  const t0 = to   || (r?.t && String(r.t).slice(0, 10))
  if (!f0 || !t0) throw new Error(`store ${storeId} has no successful scrape runs to audit`)

  const facts = await buildFacts({ storeId, from: f0, to: t0 })
  const narrative = await writeNarrative(facts, { signal })

  // The link is read and pasted by people, so it says which store and which
  // window it covers. The random tail keeps two runs of the same window apart
  // and stops a link being guessable from the store name alone.
  const id = `${slug(facts.store.name)}-${f0}-to-${t0}-${token()}`

  const seq = await one(
    `SELECT count(*)::int AS n FROM audit_reports WHERE store_id = $1`, [storeId])
  const docNo = `SCA-${String(t0).slice(0, 4)}-${String(storeId).padStart(2, '0')}${String((seq?.n ?? 0) + 1).padStart(3, '0')}`

  const html = renderReport({
    facts, narrative, id, docNo, coverage: facts.confidence.coverage })

  const ms = Date.now() - started
  await q(`
    INSERT INTO audit_reports
      (id, store_id, from_date, to_date, doc_no, facts, narrative, html,
       model, prompt_tokens, output_tokens, generated_ms)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, storeId, f0, t0, docNo, JSON.stringify(facts), JSON.stringify(narrative),
     html, narrative.model, narrative.prompt_tokens ?? null,
     narrative.output_tokens ?? null, ms])

  return {
    id, doc_no: docNo, store_id: storeId, from: f0, to: t0,
    url: `/reports/${id}`, model: narrative.model,
    verified: narrative.verified !== false,
    bytes: html.length, generated_ms: ms
  }
}
