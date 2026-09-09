/**
 * Run the Drive ingest on the company server, from here.
 *
 *   npm run ingest:drive:server              start it and watch it
 *   npm run ingest:drive:server -- --detach  start it and come back later
 *   npm run ingest:drive:server -- --status  is it running, and what did it say
 *
 * Everything else is passed straight through to ingest-drive.mjs on the
 * server: --date, --dry-run, --force, --concurrency, --archive …
 *
 *   npm run ingest:drive:server -- --dry-run
 *   npm run ingest:drive:server -- --date 2026-09-05
 *
 * This is the same job the 06:00 UTC cron runs. It is safe to run at any time
 * and as often as you like: a store+date already recorded is skipped, and the
 * files stay in Drive either way.
 *
 * --detach exists because these runs are not always quick. Google rate-limits
 * downloads, the retry waits it out, and a run has taken five hours to fetch a
 * day. Attached, that is five hours of holding an ssh session open and losing
 * the run if the laptop sleeps. Detached, the server keeps going alone.
 */
import path from 'node:path'
import { spawn } from 'node:child_process'

const SERVER = process.env.TRACKER_SSH || 'mehrban@66.45.238.72'
const KEY = process.env.TRACKER_SSH_KEY ||
            path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'tracker_deploy')

const argv = process.argv.slice(2)
const has = f => argv.includes(f)
const DETACH = has('--detach')
const STATUS = has('--status')
const passthrough = argv.filter(a => a !== '--detach' && a !== '--status')

const SSH = ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ConnectTimeout=20']
const LOG = '~/ingest.log'

/**
 * One string, not several. ssh joins everything after the host with spaces to
 * build the remote command, so passing fragments meant the quoting inside them
 * was rebuilt by two shells in a row — the first attempt lost its quotes and
 * the server tried to run `s/^/    /` as a command, one letter at a time.
 */
const run = (command, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn('ssh', [...SSH, SERVER, command], { stdio: 'inherit', shell: false, ...opts })
  p.on('error', reject)
  p.on('close', code => resolve(code))
})

/**
 * The brackets are load-bearing. pgrep -f matches against whole command lines,
 * and the command line doing the asking contains the pattern too — so a plain
 * "ingest-drive" found this very check and reported a run in progress when the
 * server was idle. `ingest[-]drive` still matches the running job's
 * "ingest-drive.mjs", but not the literal text of this command.
 */
const RUNNING = 'pgrep -f "ingest[-]drive.mjs" >/dev/null'

if (STATUS) {
  console.log(`\n  ${SERVER}\n`)
  const code = await run(
    `if ${RUNNING}; then echo '  ● a run is in progress'; else echo '  ○ nothing running'; fi;` +
    ` echo; echo '  the last few days:';` +
    ` grep -E '^[0-9]+ of [0-9]+ stores' ${LOG} | tail -4;` +
    ` echo; echo '  end of the log:'; tail -5 ${LOG}`)
  process.exit(code)
}

const cmd = `cd ~/shopify-store-tracker/tracker && node scripts/ingest-drive.mjs ${passthrough.join(' ')}`.trim()

if (DETACH) {
  console.log(`\n  ${SERVER} — starting in the background\n`)
  // setsid so it survives this ssh session closing; the log is the only place
  // its output goes, which is where --status reads it from.
  const code = await run(
    `if ${RUNNING}; then echo '  ● already running — nothing started'; exit 0; fi;` +
    ` echo >> ${LOG};` +
    ` echo "===== $(date -u +'%Y-%m-%d %H:%M:%S UTC') (manual, detached) =====" >> ${LOG};` +
    ` setsid nohup sh -c "${cmd}" >> ${LOG} 2>&1 < /dev/null &` +
    ` sleep 3;` +
    ` if ${RUNNING}; then echo '  ● started'; else echo '  ✗ it did not start — see ${LOG}'; fi`)
  console.log(`\n  check on it:  npm run ingest:drive:server -- --status\n`)
  process.exit(code)
}

console.log(`\n  ${SERVER}\n`)
// tee, so a run watched from here still lands in the same log every other run
// writes to. Losing the connection then costs the view, not the record.
const code = await run(`${cmd} 2>&1 | tee -a ${LOG}`)
process.exit(code)
