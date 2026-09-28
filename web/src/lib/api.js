// The Worker's settings API. Every call is same-origin; the session is an HttpOnly cookie.
export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export async function api(method, path, body) {
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
