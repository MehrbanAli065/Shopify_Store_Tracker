/**
 * Google Drive access for the ingest job.
 *
 * The daily CSVs live in a Drive folder, so this is the real source — nothing
 * is read from a local project path. Three credential styles are supported,
 * in this order:
 *
 *   0. API key — the simplest, and enough when the folder is link-shareable
 *        GOOGLE_API_KEY
 *      Read-only: --archive and --trash need a real identity, not a key.
 *
 *   1. Service account (recommended for the nightly job — no browser, ever)
 *        GOOGLE_SERVICE_ACCOUNT_JSON   the key file's contents, inline
 *        GOOGLE_APPLICATION_CREDENTIALS  …or a path to that file
 *      The Drive folder must be shared with the service account's email.
 *
 *   2. OAuth refresh token (reuses the same app the Python uploader uses)
 *        GOOGLE_OAUTH_CLIENT_ID
 *        GOOGLE_OAUTH_CLIENT_SECRET
 *        GOOGLE_OAUTH_REFRESH_TOKEN
 *
 * Read-only scope is requested unless a tidy-up mode needs to modify files.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const API   = 'https://www.googleapis.com/drive/v3'
const RO    = 'https://www.googleapis.com/auth/drive.readonly'
const RW    = 'https://www.googleapis.com/auth/drive'

/** Read the folder id from the env, accepting a full Drive URL too. */
export function folderId (raw = process.env.DRIVE_FOLDER_ID) {
  const v = (raw || '').trim()
  if (!v) return null
  const m = v.match(/\/folders\/([A-Za-z0-9_-]+)/)
  return m ? m[1] : v
}

/** True when the credential can only read — an API key cannot modify files. */
export const readOnlyAuth = () =>
  !!process.env.GOOGLE_API_KEY &&
  !process.env.GOOGLE_SERVICE_ACCOUNT_JSON &&
  !process.env.GOOGLE_APPLICATION_CREDENTIALS &&
  !process.env.GOOGLE_OAUTH_REFRESH_TOKEN

/** What will actually be used — same precedence as call() below, so the banner
 *  never names a credential the request will not use. */
export function describeAuth () {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return 'service account (inline JSON)'
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS)
    return `service account (${path.basename(process.env.GOOGLE_APPLICATION_CREDENTIALS)})`
  if (process.env.GOOGLE_OAUTH_REFRESH_TOKEN) return 'OAuth refresh token'
  if (process.env.GOOGLE_API_KEY) return 'API key (folder must be link-shareable)'
  return null
}

let _tokenFn = null

/** Returns an async function that yields a valid bearer token. */
async function tokenSource (writable) {
  if (_tokenFn) return _tokenFn
  const scopes = [writable ? RW : RO]

  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS

  if (inline || keyFile) {
    const { JWT } = await import('google-auth-library')
    let creds
    try {
      creds = inline ? JSON.parse(inline) : JSON.parse(fs.readFileSync(keyFile, 'utf8'))
    } catch (e) {
      throw new Error(`could not read the service account key: ${e.message}`)
    }
    if (!creds.client_email || !creds.private_key)
      throw new Error('the service account key is missing client_email or private_key')
    const jwt = new JWT({ email: creds.client_email, key: creds.private_key, scopes })
    _tokenFn = async () => (await jwt.getAccessToken()).token
    return _tokenFn
  }

  const { GOOGLE_OAUTH_CLIENT_ID: id, GOOGLE_OAUTH_CLIENT_SECRET: secret,
          GOOGLE_OAUTH_REFRESH_TOKEN: refresh } = process.env
  if (id && secret && refresh) {
    let cached = { token: null, expires: 0 }
    _tokenFn = async () => {
      if (cached.token && Date.now() < cached.expires - 60_000) return cached.token
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: id, client_secret: secret,
                                    refresh_token: refresh, grant_type: 'refresh_token' })
      })
      const j = await res.json()
      if (!res.ok) throw new Error(`OAuth refresh failed: ${j.error_description || j.error || res.status}`)
      cached = { token: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 }
      return cached.token
    }
    return _tokenFn
  }

  throw new Error(
    'No Google credentials found. Set GOOGLE_SERVICE_ACCOUNT_JSON (or ' +
    'GOOGLE_APPLICATION_CREDENTIALS), or the GOOGLE_OAUTH_* trio. ' +
    'See DRIVE.md for the five-minute setup.')
}

async function call (url, { writable = false, raw = false, ...init } = {}) {
  const key = process.env.GOOGLE_API_KEY
  let headers = init.headers
  if (key && readOnlyAuth()) {
    if (writable) throw new Error(
      'An API key can only read. Use --archive/--trash with a service account, ' +
      'or leave the files in Drive — already-ingested days are skipped anyway.')
    url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key)
  } else {
    const token = await (await tokenSource(writable))()
    headers = { Authorization: `Bearer ${token}`, ...init.headers }
  }
  const res = await fetch(url, { ...init, headers })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error?.message || '' } catch {}
    if (res.status === 404)
      throw new Error(
        'Drive returned 404. With an API key the folder must be shared as ' +
        '"Anyone with the link"; with a service account it must be shared with ' +
        `its client_email. ${detail}`)
    throw new Error(`Drive ${res.status}: ${detail || res.statusText}`)
  }
  return raw ? res : res.json()
}

/** The folder's own metadata — 404 here means the credential cannot see it at all,
 *  which is a different problem from the folder being empty. */
export async function getFolder (folder) {
  return call(`${API}/files/${folder}?fields=id,name,mimeType&supportsAllDrives=true`)
}

/** Every CSV directly inside the folder, newest first. */
export async function listCsvFiles (folder) {
  const out = []
  let pageToken
  do {
    const p = new URLSearchParams({
      q: `'${folder}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, size, mimeType, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    })
    if (pageToken) p.set('pageToken', pageToken)
    const j = await call(`${API}/files?${p}`)
    out.push(...(j.files || []))
    pageToken = j.nextPageToken
  } while (pageToken)

  return out.filter(f =>
    f.mimeType !== 'application/vnd.google-apps.folder' && /\.csv$/i.test(f.name))
}

/** Stream one file to disk. */
export async function downloadFile (id, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const res = await call(`${API}/files/${id}?alt=media&supportsAllDrives=true`, { raw: true })
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest))
  return fs.statSync(dest).size
}

/** Send a file to the Drive trash (recoverable for 30 days). */
export async function trashFile (id) {
  await call(`${API}/files/${id}?supportsAllDrives=true`, {
    writable: true, method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true })
  })
}

/** Move a file into another folder, keeping it out of the way of the next run. */
export async function moveFile (id, toFolder, fromFolder) {
  const p = new URLSearchParams({ addParents: toFolder, supportsAllDrives: 'true' })
  if (fromFolder) p.set('removeParents', fromFolder)
  await call(`${API}/files/${id}?${p}`, { writable: true, method: 'PATCH' })
}

/** Find (or create) a subfolder by name, used for the archive destination. */
export async function ensureFolder (name, parent) {
  const p = new URLSearchParams({
    q: `'${parent}' in parents and name = '${name.replace(/'/g, "\\'")}' ` +
       `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true'
  })
  const found = await call(`${API}/files?${p}`, { writable: true })
  if (found.files?.length) return found.files[0].id

  const made = await call(`${API}/files?supportsAllDrives=true`, {
    writable: true, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] })
  })
  return made.id
}
