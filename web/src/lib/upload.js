// LoRA upload: the Worker opens a session on the Modal app, then the browser sends the file to the
// app's upload endpoint in chunks (a Modal web request is cut off after 150 s), each with its
// SHA-256, and asks the Worker to have them joined. The bytes never pass through the Worker.
import { api } from './api.js'

const PARALLEL = 3
const RETRIES = 5

async function sha256Hex(buf) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The Worker calls after the chunks (finish, status) are safe to repeat: ride out a dropped
// connection instead of losing an upload that already arrived. HTTP errors are final.
async function apiRetrying(method, path) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api(method, path)
    } catch (e) {
      if (e.status || attempt >= RETRIES) throw e
      await sleep(1000 * 2 ** attempt)
    }
  }
}

async function putChunk(url, buf, sha) {
  for (let attempt = 0; ; attempt++) {
    let status = 0
    let message = ''
    try {
      const resp = await fetch(url, { method: 'PUT', headers: { 'X-Chunk-Sha256': sha }, body: buf })
      if (resp.ok) return
      status = resp.status
      message = (await resp.json().catch(() => ({}))).error || `HTTP ${status}`
    } catch (e) {
      message = e.message // network error or CORS failure: retry
    }
    // A 4xx other than a timeout is the request's fault: retrying cannot help.
    const fatal = status >= 400 && status < 500 && status !== 408 && status !== 429
    if (fatal || attempt >= RETRIES) throw new Error(message)
    await sleep(1000 * 2 ** attempt)
  }
}

/**
 * Upload *file* as a LoRA. *onProgress* gets {phase: 'upload' | 'assemble', done, total} in bytes.
 * Resolves when the file is on the Volume; throws an Error with the reason otherwise.
 */
export async function uploadLora(file, onProgress) {
  const session = await api('POST', '/loras/uploads', { filename: file.name, size: file.size })
  const { id, chunk_size: chunkSize, chunks, upload_url: url } = session
  let sent = 0
  let next = 0
  onProgress({ phase: 'upload', done: 0, total: file.size })

  async function worker() {
    while (next < chunks) {
      const index = next++
      const buf = await file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize)).arrayBuffer()
      await putChunk(`${url}/${index}`, buf, await sha256Hex(buf))
      sent += buf.byteLength
      onProgress({ phase: 'upload', done: sent, total: file.size })
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks) }, worker))

  await apiRetrying('POST', `/loras/uploads/${id}/finish`)
  for (;;) {
    const s = await apiRetrying('GET', `/loras/uploads/${id}`)
    if (s.state === 'done') return
    if (s.state === 'failed') throw new Error(s.error || 'the upload could not be assembled')
    onProgress({ phase: 'assemble', done: s.done || 0, total: file.size })
    await sleep(1500)
  }
}
