/**
 * What is in the database, and how big it is.
 *
 *   node scripts/db-info.mjs
 *
 * Prints the connection's host, database and user, never the password: this
 * output gets pasted into messages and tickets.
 */
import 'dotenv/config'
import { q, one, close, describe, MODE } from '../lib/db.mjs'

const url = process.env.DATABASE_URL || ''
let u = null
try { u = new URL(url) } catch {}

console.log(`\n  ── connection ──`)
console.log(`  mode      ${MODE}`)
console.log(`  target    ${describe()}`)
if (u) {
  console.log(`  host      ${u.hostname}`)
  console.log(`  port      ${u.port || 5432}`)
  console.log(`  database  ${u.pathname.replace(/^\//, '')}`)
  console.log(`  user      ${u.username}`)
  console.log(`  password  (in tracker/.env, not printed)`)
  console.log(`  params    ${u.search.replace(/^\?/, '') || '(none)'}`)
}

const v = await one(`SELECT version() AS v, current_database() AS db, current_user AS usr`)
console.log(`  server    ${String(v.v).split(' on ')[0]}`)

const size = await one(`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`)
console.log(`  db size   ${size.s}`)

console.log(`\n  ── tables ──`)
const tables = await q(`
  SELECT c.relname AS name,
         pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
         pg_total_relation_size(c.oid) AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY pg_total_relation_size(c.oid) DESC`)

for (const t of tables) {
  const n = await one(`SELECT count(*)::bigint AS n FROM ${t.name}`)
  console.log(`   ${t.name.padEnd(18)} ${String(n.n).padStart(9)} rows   ${t.size.padStart(9)}`)
}

const views = await q(`
  SELECT table_name FROM information_schema.views WHERE table_schema = 'public' ORDER BY 1`)
const funcs = await q(`
  SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' ORDER BY 1`)
console.log(`\n  views     ${views.map(r => r.table_name).join(', ') || '(none)'}`)
console.log(`  functions ${funcs.map(r => r.proname).join(', ') || '(none)'}`)

console.log(`\n  ── stores ──`)
const stores = await q(`
  SELECT s.id, s.name, s.domain, s.currency,
         (SELECT count(*) FROM scrape_runs r WHERE r.store_id = s.id)::int AS runs,
         (SELECT min(run_date) FROM scrape_runs r WHERE r.store_id = s.id) AS first_run,
         (SELECT max(run_date) FROM scrape_runs r WHERE r.store_id = s.id) AS last_run,
         (SELECT count(*) FROM products p WHERE p.store_id = s.id AND p.is_active)::int AS products,
         (SELECT count(*) FROM variants v JOIN products p ON p.id = v.product_id
           WHERE p.store_id = s.id AND v.is_active)::int AS variants
    FROM stores s ORDER BY s.id`)
for (const s of stores)
  console.log(`   [${s.id}] ${s.name.padEnd(16)} ${s.domain.padEnd(24)} ${s.currency}  ` +
              `${s.runs} run(s) ${String(s.first_run).slice(0, 10)}→${String(s.last_run).slice(0, 10)}  ` +
              `${s.products} products · ${s.variants} variants`)

console.log(`\n  ── history by change type ──`)
const types = await q(`
  SELECT change_type, count(*)::bigint AS n FROM variant_history GROUP BY 1 ORDER BY n DESC`)
for (const t of types) console.log(`   ${t.change_type.padEnd(18)} ${String(t.n).padStart(9)}`)

const reports = await one(`SELECT count(*)::int AS n FROM audit_reports`).catch(() => ({ n: 0 }))
console.log(`\n  audit reports stored: ${reports?.n ?? 0}\n`)

await close()
