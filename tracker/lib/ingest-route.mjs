/**
 * A remote trigger for the nightly ingest, so n8n can start it from another
 * machine. Mounted only when INGEST_TOKEN is set — with no token the routes do
 * not exist at all, rather than existing and refusing.
 *
 *   POST /api/ingest          start a run, answer 202 immediately
 *   GET  /api/ingest/status   what the current or last run is doing
 *
 * Both need the token in an X-Ingest-Token header.
 *
 * It answers 202 rather than holding the connection because a 100-store ingest
 * takes minutes, and no proxy between n8n and here can be relied on to keep an
 * idle connection open that long. The caller polls the status route instead.
 */
import express from 'express'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'

const MAX_OUT = 200_000        // keep the tail; a full 100-store log is larger

let running = null             // { startedAt, pid, out }
let last    = null             // { startedAt, finishedAt, code, out }

function tokenOk (given) {
  const want = process.env.INGEST_TOKEN || ''
  if (!want || !given) return false
  const a = Buffer.from(String(given))
  const b = Buffer.from(want)
  // timingSafeEqual throws on a length mismatch, and the length is not a secret
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Build argv from the request without ever putting caller-supplied text on it.
 * Every value is either a fixed flag or a number/date this function validated,
 * so there is nothing to inject through.
 */
function argsFrom (body = {}) {
  const argv = []

  // Defaults to 'none' because the cleanup flags need write access to Drive,
  // and an API key does not have it — ingest-drive.mjs refuses the whole run
  // rather than skipping the tidy-up. A caller that fires and forgets would
  // never notice. Set INGEST_CLEANUP=delete once a service account is in place;
  // Drive quota is only freed by that one.
  const cleanup = String(body.cleanup ?? process.env.INGEST_CLEANUP ?? 'none')
  if (!['delete', 'archive', 'trash', 'none'].includes(cleanup)) {
    throw new Error(`cleanup must be delete, archive, trash or none — got "${cleanup}"`)
  }
  if (cleanup !== 'none') argv.push(`--${cleanup}`)

  const conc = Number(body.concurrency ?? 3)
  if (!Number.isInteger(conc) || conc < 1 || conc > 10) {
    throw new Error('concurrency must be a whole number from 1 to 10')
  }
  argv.push('--concurrency', String(conc))

  if (body.date != null) {
    const date = String(body.date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD')
    argv.push('--date', date)
  }

  if (body.dryRun) argv.push('--dry-run')

  return argv
}

export default function ingestRoute (ROOT) {
  const router = express.Router()

  // Ingest reads multi-megabyte CSVs and runs for minutes; Vercel functions cap
  // at 60s and have no writable working directory. Mounting here would produce
  // a route that answers 202 and then dies silently, which is worse than absent.
  if (process.env.VERCEL) return router
  if (!process.env.INGEST_TOKEN) return router

  router.use(express.json({ limit: '8kb' }))
  router.use((req, res, next) =>
    tokenOk(req.get('X-Ingest-Token'))
      ? next()
      : res.status(401).json({ error: 'bad or missing X-Ingest-Token' }))

  router.post('/api/ingest', (req, res) => {
    if (running) {
      return res.status(409).json({
        error: 'an ingest is already running',
        startedAt: running.startedAt,
      })
    }

    let argv
    try {
      argv = argsFrom(req.body)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    const script = path.join(ROOT, 'scripts', 'ingest-drive.mjs')
    const child = spawn(process.execPath, [script, ...argv],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

    const startedAt = new Date().toISOString()
    const state = { startedAt, pid: child.pid, out: '' }
    const append = chunk => {
      state.out += chunk
      if (state.out.length > MAX_OUT) state.out = state.out.slice(-MAX_OUT)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    child.on('error', e => {
      last = { ...state, finishedAt: new Date().toISOString(), code: 1,
               out: `${state.out}\n  ✗ could not start the ingest: ${e.message}` }
      running = null
    })
    child.on('close', code => {
      last = { ...state, out: state.out, finishedAt: new Date().toISOString(), code }
      running = null
    })

    running = state
    console.log(`  ingest started by remote trigger — pid ${child.pid}, ${argv.join(' ')}`)
    res.status(202).json({ started: true, startedAt, args: argv })
  })

  router.get('/api/ingest/status', (_req, res) => {
    if (running) {
      return res.json({
        running: true,
        startedAt: running.startedAt,
        out: running.out,
      })
    }
    if (!last) return res.json({ running: false, code: null, out: '', never: true })
    res.json({
      running: false,
      startedAt: last.startedAt,
      finishedAt: last.finishedAt,
      code: last.code,
      out: last.out,
    })
  })

  return router
}
