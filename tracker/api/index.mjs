/**
 * Everything the browser asks for under /api or /reports arrives here.
 *
 * The tracker's API runs on the company server. It speaks plain HTTP and has
 * no login of its own, so this function is the only door to it: it holds the
 * shared token, and the browser never sees it. The page itself only ever talks
 * to this origin over HTTPS, which is also why no CORS is involved.
 */
export const config = { api: { bodyParser: false } }

const ORIGIN = process.env.TRACKER_API_ORIGIN   // e.g. http://66.45.238.72:3200
const TOKEN = process.env.TRACKER_API_TOKEN

function read (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler (req, res) {
  if (!ORIGIN || !TOKEN) {
    return res.status(500).json({ error: 'proxy not configured' })
  }

  const headers = { 'x-tracker-token': TOKEN }
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type']

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'

  try {
    const upstream = await fetch(ORIGIN + req.url, {
      method: req.method,
      headers,
      body: hasBody ? await read(req) : undefined,
      // Reports take ~20s. Vercel kills the function at 60s, so stop just short.
      signal: AbortSignal.timeout(55000),
    })

    const type = upstream.headers.get('content-type')
    if (type) res.setHeader('Content-Type', type)
    const disp = upstream.headers.get('content-disposition')
    if (disp) res.setHeader('Content-Disposition', disp)

    // fetch has already un-gzipped this; letting the old header through would
    // tell the browser to unzip plain bytes and it would fail on every reply.
    res.status(upstream.status)
    res.send(Buffer.from(await upstream.arrayBuffer()))
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'upstream timed out' : 'upstream unreachable' })
  }
}
