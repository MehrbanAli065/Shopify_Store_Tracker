/**
 * Dual-mode database layer.
 *
 *   DATABASE_URL set   →  hosted PostgreSQL (Neon / Supabase / any Postgres)  ← production
 *   DATABASE_URL unset →  PGlite, an embedded Postgres file under data/       ← local dev
 *
 * Both expose the same q / one / exec API and the same $1-style parameters,
 * so nothing above this file has to know which one is running.
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const DATA_DIR = path.join(root, 'data', 'pgdata')
export const ROOT = root

// load .env when present (local only; Vercel injects env vars directly)
if (fs.existsSync(path.join(root, '.env'))) {
  const { config } = await import('dotenv')
  config({ path: path.join(root, '.env') })
}

// Vercel's Postgres/Neon integration injects one of these depending on how the
// store was created, so accept any of them rather than failing confusingly.
const URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL_UNPOOLED || ''

export const MODE = URL ? 'postgres' : 'pglite'

let _pool = null   // hosted Postgres
let _lite = null   // PGlite

async function pool () {
  if (!_pool) {
    const { default: pg } = await import('pg')

    // A DATE has no time and no zone. Left alone, pg turns it into a JS Date at
    // LOCAL midnight, and toISOString() then rolls it back a day east of UTC —
    // 2026-07-27 would surface as 2026-07-26. Hand it back as the plain string.
    pg.types.setTypeParser(1082, v => v)          // date
    pg.types.setTypeParser(1700, v => v)          // numeric — keep full precision

    _pool = new pg.Pool({
      connectionString: URL,
      // hosted Postgres needs TLS; the pooled endpoints use a shared cert
      ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_MAX || 3),        // serverless: keep it small
      idleTimeoutMillis: 10_000,
      // A suspended Neon compute took 13.5s to wake in testing, and the old
      // 15s ceiling left almost nothing over it: the first visit after an idle
      // spell failed rather than waited.
      connectionTimeoutMillis: 30_000,
      keepAlive: true
    })

    // Neon suspends its compute when idle and the sockets die with it. Without
    // a handler here, pg raises that as an unhandled error on the pool; with
    // one, the dead client is simply discarded and the next call opens a fresh
    // connection. This is the difference between a page that recovers and one
    // that hangs until the process is restarted.
    _pool.on('error', err => console.warn(`  pool client dropped: ${err.message}`))
  }
  return _pool
}

async function lite () {
  if (process.env.VERCEL) {
    throw new Error(
      'No database connection string found. Vercel has no persistent filesystem, so the ' +
      'local PGlite database cannot be used there. Create a Postgres store under the ' +
      'project\'s Storage tab (or set DATABASE_URL yourself in Settings → Environment ' +
      'Variables), then redeploy.')
  }
  if (!_lite) {
    const { PGlite } = await import('@electric-sql/pglite')
    fs.mkdirSync(DATA_DIR, { recursive: true })   // PGlite will not create parents
    _lite = await PGlite.create(DATA_DIR)
  }
  return _lite
}

/**
 * A connection that died while the compute was suspended is handed out once
 * before the pool notices. That failure is not the query's fault and retrying
 * it costs one round trip, so the caller never sees it. Anything that is
 * actually wrong with the SQL throws on the first attempt and is left alone.
 */
const DEAD_CONNECTION = /Connection terminated|connection timeout|ECONNRESET|ETIMEDOUT|server closed the connection/i

/** Run a query, return rows. */
export async function q (sql, params = []) {
  if (MODE !== 'postgres') {
    const res = await (await lite()).query(sql, params)
    return res.rows
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await (await pool()).query(sql, params)
      return res.rows
    } catch (err) {
      if (attempt >= 1 || !DEAD_CONNECTION.test(err.message || '')) throw err
      console.warn(`  retrying after a dropped connection: ${err.message}`)
    }
  }
}

/** Run a query, return the first row or null. */
export async function one (sql, params = []) {
  const rows = await q(sql, params)
  return rows[0] ?? null
}

/** Run a multi-statement script (schema, seed). */
export async function exec (sql) {
  if (MODE === 'postgres') {
    const client = await (await pool()).connect()
    try { return await client.query(sql) } finally { client.release() }
  }
  return (await lite()).exec(sql)
}

export async function close () {
  if (_pool) { await _pool.end(); _pool = null }
  if (_lite) { await _lite.close(); _lite = null }
}

/** Human-readable description of where we are pointed. */
export function describe () {
  if (MODE === 'pglite') return 'PGlite (local file · data/pgdata)'
  try {
    const u = new global.URL(URL)
    return `PostgreSQL · ${u.hostname}${u.pathname}`
  } catch { return 'PostgreSQL (DATABASE_URL)' }
}
