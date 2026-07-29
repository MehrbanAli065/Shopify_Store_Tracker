/**
 * Local dev server. On Vercel, api/index.mjs mounts the same app instead.
 */
import app from './app.mjs'
import { describe, MODE } from './lib/db.mjs'

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log('')
  console.log('  Shopify Store Tracker')
  console.log(`  db   ${describe()}  [${MODE}]`)
  console.log(`  url  http://localhost:${PORT}`)
  console.log('')
})
