/**
 * Local dev server. On Vercel, api/index.mjs mounts the same app instead.
 */
import app from './app.mjs'
import { describe, MODE } from './lib/db.mjs'

const PORT = process.env.PORT || 3000

// Behind a reverse proxy the app must not be reachable on the public
// interface directly — there is no auth on it yet. Localhost by default;
// set HOST=0.0.0.0 only where that is actually wanted.
const HOST = process.env.HOST || '127.0.0.1'

app.listen(PORT, HOST, () => {
  console.log('')
  console.log('  Shopify Store Tracker')
  console.log(`  db   ${describe()}  [${MODE}]`)
  console.log(`  url  http://${HOST}:${PORT}`)
  console.log('')
})
