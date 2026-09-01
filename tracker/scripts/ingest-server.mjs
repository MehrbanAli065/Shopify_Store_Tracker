/**
 * Ingest a local folder of CSVs into the database on the company server.
 *
 *   npm run ingest:server -- --dir "E:\Project CSV\2026-09-01"
 *
 * Options are the same as ingest-folder.mjs and are passed straight through:
 *   --date, --concurrency, --dry-run, --force
 *
 * The CSVs go to the server and ingest runs there, rather than ingest running
 * here against the server's database. That is not a preference — matching one
 * day's file against a large store means reading its whole variant table, and
 * over this link that is minutes per store: pulling 553,524 rows for one store
 * did not finish in ten. Sending the files is a few MB; sending the answers to
 * every query is not.
 *
 * The server's Postgres listens on localhost only, so ingest running there
 * talks to it over a socket and the link is never in the way.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const SERVER = process.env.TRACKER_SSH || 'mehrban@66.45.238.72'
const KEY = process.env.TRACKER_SSH_KEY ||
            path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'tracker_deploy')
const REMOTE_DIR = '/tmp/ingest-csv'

const argv = process.argv.slice(2)
const i = argv.indexOf('--dir')
if (i < 0 || !argv[i + 1]) {
  console.error('')
  console.error('  --dir chahiye:  npm run ingest:server -- --dir "E:/Project CSV/2026-09-01"')
  console.error('')
  process.exit(1)
}
const DIR = argv[i + 1]
if (!fs.existsSync(DIR)) { console.error(`\n  folder nahi mila: ${DIR}\n`); process.exit(1) }

// Everything except --dir is the remote job's business, not ours.
const passthrough = argv.filter((_, n) => n !== i && n !== i + 1)

const csvs = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.csv'))
if (!csvs.length) { console.error(`\n  is folder mein koi CSV nahi: ${DIR}\n`); process.exit(1) }
const mb = csvs.reduce((s, f) => s + fs.statSync(path.join(DIR, f)).size, 0) / 1048576

console.log(`\n  ${csvs.length} CSV · ${mb.toFixed(0)} MB  →  ${SERVER}\n`)

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts })
  p.on('error', reject)
  p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)))
})

const ssh = ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30']

try {
  console.log(`· bhej raha hoon — gzip ke sath, warna is link par 55 minute lagte hain …`)
  await run('ssh', [...ssh, SERVER, `rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}`])

  // CSV 88% dabta hai: 863 MB ka din ~108 MB ban jata hai. Stream kiya ja raha
  // hai, kahin koi aarzi file nahi banti — na yahan, na server par.
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['czf', '-', '-C', DIR, ...csvs], { stdio: ['ignore', 'pipe', 'inherit'] })
    const put = spawn('ssh', [...ssh, SERVER, `tar xzf - -C ${REMOTE_DIR}`],
                      { stdio: ['pipe', 'inherit', 'inherit'] })
    tar.stdout.pipe(put.stdin)
    tar.on('error', reject)
    put.on('error', reject)
    put.on('close', c => c === 0 ? resolve() : reject(new Error(`transfer exited ${c}`)))
  })

  console.log('· server par ingest chal rahi hai …\n')
  const remote = [
    'cd ~/tracker',
    `node scripts/ingest-folder.mjs --dir ${REMOTE_DIR} ${passthrough.join(' ')}`.trim(),
  ].join(' && ')
  await run('ssh', [...ssh, SERVER, remote])

  // Only after a clean run. A failed batch is worth keeping to look at.
  await run('ssh', [...ssh, SERVER, `rm -rf ${REMOTE_DIR}`])
  console.log('\n  ho gaya — data server ki database mein hai\n')
} catch (err) {
  console.error(`\n  ruk gaya: ${err.message}`)
  console.error(`  CSVs server par ${REMOTE_DIR} mein pade hain, dekhne ke liye\n`)
  process.exit(1)
}
