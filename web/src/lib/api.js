// The Worker's settings API. Every call is same-origin; the session is an HttpOnly cookie.
export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// A PC's own page on the Worker (/gpu/<id>, design §9 "A page per PC"): the app runs as that PC's
// agent page, and its calls go to the PC through the Worker's relay, /api/gpus/<id>/machine/…
// Logging in and out stay the Worker's.
export const pcPage = /^\/gpu\/([\w-]+)\/?$/.exec(location.pathname)?.[1] ?? null
const WORKER_ONLY = new Set(['/login', '/logout', '/password'])

/** A call of this page's API: the Worker's, or on a PC's page the PC's (relayed). */
export const api = (method, path, body) =>
  call(method, pcPage && !WORKER_ONLY.has(path) ? `/gpus/${pcPage}/machine${path}` : path, body)

/** A call of the Worker's own API, from any page. */
export const workerApi = (method, path, body) => call(method, path, body)

async function call(method, path, body) {
  const resp = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = {}
  try {
    data = await resp.json()
  } catch {
    // empty or non-JSON body
  }
  if (!resp.ok) throw new ApiError(resp.status, data.error || `HTTP ${resp.status}`)
  return data
}

export function formatBytes(n) {
  if (!n) return ''
  const gb = n / 1e9
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`
}

// Pre-filled Cloudflare user-token page (design §8). Keys verified 2026-09-27.
const TOKEN_PERMISSIONS = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'account_settings', type: 'read' },
  { key: 'workers_ci', type: 'edit' },
  { key: 'workers_observability', type: 'read' },
]

export const TOKEN_TEMPLATE_URL =
  'https://dash.cloudflare.com/profile/api-tokens?' +
  new URLSearchParams({
    permissionGroupKeys: JSON.stringify(TOKEN_PERMISSIONS),
    accountId: '*',
    zoneId: 'all',
    name: 'Comfy-Gen-MCP',
  })

// The walkthroughs' screenshots live on the project site, not in this app (which the local bundle also embeds).
export const GUIDE = 'https://lugia19.github.io/comfyui-gen-mcp/guide/'
// The walkthroughs (WalkGuide.svelte), loaded once: fixing one needs no release.
let guides = null
export const loadGuides = () =>
  (guides ??= fetch(GUIDE + 'guides.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText)))).catch((e) => {
    guides = null
    throw e
  }))

/** Short names for the agent's GPU kinds (its hello's `gpu`). */
export const GPU_NAMES = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel Arc', mac: 'Apple silicon', cpu: 'CPU only' }
export const gpuName = (id) => GPU_NAMES[id] ?? id
export const platformName = (p) => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[p] ?? p

/** The R2 bucket's img/ folder in Cloudflare's dashboard, or '' if the login didn't find the account:
 * the build names the bucket <worker>-storage (deploy.py). */
export const imagesUrl = (info) =>
  info.cloudflare?.account_id && info.cloudflare?.script
    ? `https://dash.cloudflare.com/${info.cloudflare.account_id}/r2/default/buckets/${info.cloudflare.script}-storage?prefix=img%2F`
    : ''
