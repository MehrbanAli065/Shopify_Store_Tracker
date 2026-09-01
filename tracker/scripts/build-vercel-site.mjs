/**
 * Vercel gets its own folder, assembled here.
 *
 * The repo keeps the pages under public/ because that is where Express serves
 * them from. Vercel, with no framework and no build, wants the static files at
 * the root and functions under api/ — so rather than bend either side, the
 * shape it expects is built into vercel-site/ and deployed from there. It also
 * means only these files can ever reach Vercel: no server code, no .env.
 *
 *   node scripts/build-vercel-site.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'vercel-site')

// Everything is rebuilt except the Vercel CLI's own state. Wiping .vercel
// would unlink the folder from the project, and the next deploy would quietly
// create a second one instead of updating this deployment.
const KEEP = new Set(['.vercel', '.env.local', '.gitignore'])

if (fs.existsSync(OUT)) {
  for (const f of fs.readdirSync(OUT)) {
    if (KEEP.has(f)) continue
    fs.rmSync(path.join(OUT, f), { recursive: true, force: true })
  }
}
fs.mkdirSync(path.join(OUT, 'api'), { recursive: true })

// The working copies (.bak, .bak2 …) live alongside the real pages; they
// are scratch, and shipping them would publish older versions of the site.
const PAGE = /.(html|css|js|svg|png|ico|woff2?)$/

for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter(f => PAGE.test(f))) {
  fs.copyFileSync(path.join(ROOT, 'public', f), path.join(OUT, f))
  console.log('  ' + f)
}
fs.copyFileSync(path.join(ROOT, 'api', 'index.mjs'), path.join(OUT, 'api', 'index.mjs'))
console.log('  api/index.mjs')

fs.writeFileSync(path.join(OUT, 'vercel.json'), JSON.stringify({
  $schema: 'https://openapi.vercel.sh/vercel.json',
  rewrites: [
    { source: '/api/(.*)', destination: '/api/index.mjs' },
    { source: '/reports/(.*)', destination: '/api/index.mjs' },
  ],
  functions: { 'api/index.mjs': { maxDuration: 60 } },
  headers: [{
    source: '/app.css',
    headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }],
  }],
}, null, 2) + '\n')
console.log('  vercel.json')
console.log('\n  vercel-site/ tayyar')
