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
import crypto from 'node:crypto'
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

// app.css is served with a day of caching, which is right for a file that
// rarely changes and wrong the moment it does: the pages redeploy on a push
// and update instantly, while browsers keep yesterday's stylesheet for up to
// 24 hours. New markup then renders against old rules, which is not a subtle
// failure — the change-log filters came out stacked and unstyled.
//
// So the link carries the stylesheet's own content hash. Same CSS, same URL,
// still cached; changed CSS, new URL, fetched at once.
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'app.css'))
const CSS_V = crypto.createHash('sha256').update(CSS).digest('hex').slice(0, 8)

for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter(f => PAGE.test(f))) {
  const src = path.join(ROOT, 'public', f)
  if (f.endsWith('.html')) {
    const html = fs.readFileSync(src, 'utf8')
      .replaceAll('href="/app.css"', `href="/app.css?v=${CSS_V}"`)
    fs.writeFileSync(path.join(OUT, f), html)
  } else {
    fs.copyFileSync(src, path.join(OUT, f))
  }
  console.log('  ' + f)
}
console.log(`  app.css version ${CSS_V}`)
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
