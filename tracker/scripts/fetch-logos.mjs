/**
 * Fetch every store's logo once and keep it, so the dashboard never asks a
 * store's server for an image while someone is looking at the page.
 *
 *   npm run logos            fetch the ones we do not have
 *   npm run logos -- --force fetch all of them again
 *
 * Measured on 2 Sep 2026: about 1.3s per store, 8 at a time, so all 242 take
 * under a minute. Re-running is cheap because a store already on disk is
 * skipped.
 *
 * Not /favicon.ico. That is the obvious address and it is the wrong one: all
 * 24 stores sampled answered 404 there. Shopify does not serve a root favicon
 * — the icon is declared in the homepage's <link rel="icon">, usually pointing
 * at Shopify's CDN. So the homepage is read for that link. It costs ~330 KB of
 * HTML per store, which is a fine price to pay once.
 *
 * Google's favicon service is the fallback, not the default: it is a third
 * party between us and a picture we can hold ourselves, and it tops out at
 * 64px. It earns its place on the stores whose markup declares nothing.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { q, close, describe, MODE, ROOT } from '../lib/db.mjs'

const OUT = path.join(ROOT, 'public', 'logos')
// Three, not eight. Eight got the first 126 stores and then Shopify began
// answering 429 to everything: the remaining 116 all failed inside a fifth of
// a second each, which is what being throttled looks like from here. This is a
// job that runs once, so there is nothing to buy by going fast.
const CONC = 3
const FORCE = process.argv.includes('--force')

const EXT = { 'image/png': 'png', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
              'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif' }

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** One request, with a wait-and-retry when the store says we are too fast. */
const get = async (url, ms = 10000, tries = 3) => {
  for (let n = 1; ; n++) {
    const res = await once(url, ms)
    if (res.status !== 429 || n === tries) return res
    // Shopify's 429 carries no Retry-After, so back off on our own: 4s, 8s.
    await sleep(4000 * n)
  }
}

const once = async (url, ms = 10000) => {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    return await fetch(url, { signal: ac.signal, redirect: 'follow', headers: {
      // Some storefronts answer a bare fetch with a bot wall; a normal browser
      // string gets the same HTML a visitor would see.
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept': 'text/html,image/*,*/*'
    } })
  } finally { clearTimeout(t) }
}

/** The biggest icon the page declares, not merely the first. */
function pickIcon (html, base) {
  const links = html.match(/<link[^>]+>/gi) || []
  const found = []
  for (const tag of links) {
    const rel = tag.match(/rel=["']([^"']+)["']/i)?.[1] || ''
    if (!/\bicon\b/i.test(rel)) continue
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1]
    if (!href) continue
    const sizes = tag.match(/sizes=["'](\d+)/i)?.[1]
    // Shopify serves one image at any width via ?width=; ask for a useful one.
    let url
    try { url = new URL(href, base).href } catch { continue }
    found.push({ url, size: Number(sizes) || (/apple-touch/i.test(rel) ? 180 : 32) })
  }
  found.sort((a, b) => b.size - a.size)
  return found[0]?.url || null
}

async function fetchLogo (store) {
  const base = `https://${store.domain}/`
  // 1 · the store's own declaration
  try {
    const res = await get(base)
    if (res.ok) {
      const html = (await res.text()).slice(0, 400_000)
      const icon = pickIcon(html, base)
      if (icon) {
        const ic = await get(icon.includes('?') ? `${icon}&width=128` : `${icon}?width=128`)
        if (ic.ok) {
          const buf = Buffer.from(await ic.arrayBuffer())
          const type = (ic.headers.get('content-type') || '').split(';')[0].trim()
          if (buf.length > 70 && EXT[type]) return { buf, ext: EXT[type], via: 'site' }
        }
      }
    }
  } catch {}

  // 2 · the fallback, for the ones that declare nothing
  try {
    const res = await get(`https://www.google.com/s2/favicons?sz=64&domain=${store.domain}`)
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      // The service answers 200 with a grey globe when it has nothing, so its
      // answer has to be told apart from a real icon. Not by size: that was
      // the first attempt and it threw away real logos of 310, 599 and 787
      // bytes because the globe happens to be 726. The globe is one fixed
      // file, so it is recognised by its hash, fetched once at startup by
      // asking about a domain that cannot have one.
      if (buf.length > 70 && sha(buf) !== PLACEHOLDER) return { buf, ext: 'png', via: 'google' }
    }
  } catch {}

  return null
}

// ── run ───────────────────────────────────────────────────────────
const sha = b => crypto.createHash('sha1').update(b).digest('hex')

/** What the favicon service returns when it has nothing to return. */
async function placeholderHash () {
  try {
    const res = await get('https://www.google.com/s2/favicons?sz=64&domain=nothing.invalid')
    if (res.ok) return sha(Buffer.from(await res.arrayBuffer()))
  } catch {}
  return null
}

console.log(`\n  target: ${describe()}  [${MODE}]`)
fs.mkdirSync(OUT, { recursive: true })
const PLACEHOLDER = await placeholderHash()

const stores = await q(`SELECT id, name, domain FROM stores WHERE active ORDER BY id`)
const have = new Set(fs.readdirSync(OUT).map(f => f.replace(/\.\w+$/, '')))
const todo = FORCE ? stores : stores.filter(s => !have.has(String(s.id)))

console.log(`  ${stores.length} active stores · ${have.size} already on disk · ${todo.length} to fetch\n`)
if (!todo.length) { console.log('  nothing to do\n'); await close(); process.exit(0) }

const t0 = Date.now()
let i = 0, ok = 0, viaGoogle = 0
const missed = []

await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < todo.length) {
    const s = todo[i++]
    if (i > CONC) await sleep(300)
    const got = await fetchLogo(s)
    if (got) {
      // One file per store id, so a store cannot end up with two of them when
      // the type changes between runs.
      for (const f of fs.readdirSync(OUT)) if (f.startsWith(s.id + '.')) fs.rmSync(path.join(OUT, f))
      fs.writeFileSync(path.join(OUT, `${s.id}.${got.ext}`), got.buf)
      ok++
      if (got.via === 'google') viaGoogle++
    } else {
      missed.push(`${s.id} ${s.name} (${s.domain})`)
    }
    
    if ((ok + missed.length) % 25 === 0) process.stdout.write(`  ${ok + missed.length}/${todo.length}\r`)
  }
}))

// A manifest, because the files are png, jpg, svg, gif and webp depending on
// what each store publishes. Without it every page would have to guess an
// extension and take a 404 for each wrong guess.
const manifest = {}
for (const f of fs.readdirSync(OUT).sort()) {
  const id = f.replace(/\.\w+$/, '')
  if (/^\d+$/.test(id)) manifest[id] = f
}
fs.writeFileSync(path.join(ROOT, 'public', 'logos.json'), JSON.stringify(manifest) + '\n')

const secs = ((Date.now() - t0) / 1000).toFixed(1)
const bytes = fs.readdirSync(OUT).reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0)

console.log(`  got ${ok}/${todo.length} in ${secs}s  (${viaGoogle} from the fallback)`)
console.log(`  on disk: ${fs.readdirSync(OUT).length} logos, ${(bytes / 1024).toFixed(0)} KB total`)
if (missed.length) {
  console.log(`\n  no logo found — these keep the initials tile:`)
  for (const m of missed) console.log(`    ${m}`)
}
console.log()

await close()
