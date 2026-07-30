/**
 * Test the Drive connection and say exactly what is wrong.
 *
 *   npm run drive:check
 *
 * Runs the same calls the nightly job makes, one at a time, so a failure points
 * at the step that failed instead of a bare 404.
 */
import { folderId, describeAuth, readOnlyAuth, listCsvFiles, getFolder } from '../lib/drive.mjs'
import { q, close, describe, MODE } from '../lib/db.mjs'

const FOLDER = folderId(process.argv.includes('--folder')
  ? process.argv[process.argv.indexOf('--folder') + 1]
  : process.env.DRIVE_FOLDER_ID)

const ok   = m => console.log(`  ✓ ${m}`)
const bad  = m => console.log(`  ✗ ${m}`)
const hint = m => console.log(`      ${m}`)

console.log('')

// ── 1 · folder ────────────────────────────────────────────────────
if (!FOLDER) {
  bad('No folder configured')
  hint('Add this to tracker/.env — the id or the whole URL both work:')
  hint('DRIVE_FOLDER_ID=https://drive.google.com/drive/folders/YOUR_ID')
  process.exit(1)
}
ok(`Folder id: ${FOLDER}`)

// ── 2 · credential ────────────────────────────────────────────────
const auth = describeAuth()
if (!auth) {
  bad('No Google credential')
  hint('The smallest option is an API key — two minutes, never expires:')
  hint('')
  hint('1. Drive: open the folder → Share → "Anyone with the link" → Viewer')
  hint('2. https://console.cloud.google.com → APIs & Services → Credentials')
  hint('   → Create credentials → API key → copy it')
  hint('3. tracker/.env:   GOOGLE_API_KEY=AIza...')
  hint('')
  hint('DRIVE.md also covers service accounts and OAuth.')
  process.exit(1)
}
ok(`Credential: ${auth}`)
if (readOnlyAuth()) hint('read-only, so --archive and --trash will not be available')

// ── 3 · can it see the folder? ────────────────────────────────────
let files
try {
  files = await listCsvFiles(FOLDER)
  ok(`Listing succeeded — ${files.length} CSV file(s) visible`)
} catch (e) {
  bad(`Cannot read the folder: ${e.message}`)
  hint('')
  if (readOnlyAuth()) {
    hint('With an API key the folder must be shared as "Anyone with the link".')
    hint('Restricted folders are invisible to a key, and Drive answers 404.')
  } else {
    hint('A service account is not you — share the folder with its client_email.')
    hint('An OAuth app scoped to drive.file only sees files it created itself.')
  }
  await close(); process.exit(1)
}

if (!files.length) {
  // An empty list and an invisible folder look identical from the query alone,
  // so ask about the folder itself before blaming the folder's contents.
  let visible = null
  try { visible = await getFolder(FOLDER) } catch { visible = null }

  if (!visible) {
    bad('The folder is not visible to this credential')
    hint('The listing came back empty, but the folder itself cannot be opened —')
    hint('so this is a permissions problem, not an empty folder.')
    hint('')
    if (readOnlyAuth()) {
      hint('Share the folder as "Anyone with the link" for an API key to read it.')
    } else if (describeAuth().startsWith('OAuth')) {
      hint('This OAuth app is scoped to drive.file, which only exposes files the')
      hint('app itself created. It cannot see a folder you made in the Drive UI.')
      hint('Use an API key or a service account instead — DRIVE.md covers both.')
    } else {
      hint("Share the folder with the service account's client_email address.")
    }
  } else {
    bad(`"${visible.name}" is readable but holds no CSV files`)
    hint('Only files directly inside it are listed — subfolders are ignored.')
    hint('Check the id points at the folder holding the CSVs, not its parent.')
  }
  await close(); process.exit(1)
}

// ── 4 · do the filenames map to stores? ───────────────────────────
const stores = await q('SELECT id, name, csv_prefix FROM stores WHERE active ORDER BY id')
ok(`Database reachable — ${stores.length} active store(s)  [${MODE}]`)

const matched = [], unmatched = []
for (const f of files) {
  const s = stores
    .filter(x => x.csv_prefix && f.name.toLowerCase().startsWith(x.csv_prefix.toLowerCase()))
    .sort((a, b) => b.csv_prefix.length - a.csv_prefix.length)[0]
  ;(s ? matched : unmatched).push({ f, s })
}

console.log('')
for (const { f, s } of matched) {
  console.log(`    ${String(s.id).padStart(3)} ${s.name.padEnd(18)} ${f.name}`)
}
for (const { f } of unmatched) {
  console.log(`      ?  ${'(no store)'.padEnd(18)} ${f.name}`)
}

console.log('')
if (unmatched.length) {
  bad(`${unmatched.length} file(s) match no store`)
  hint('Add the store to db/seed.sql and run `npm run seed`, or correct its')
  hint('csv_prefix so it matches the start of the filename.')
}
if (matched.length) {
  ok(`${matched.length} file(s) ready to ingest`)
  console.log('')
  console.log('  Next:  npm run ingest:drive -- --dry-run')
  console.log('  Then:  npm run ingest:drive')
}
console.log('')

await close()
process.exit(matched.length ? 0 : 1)
