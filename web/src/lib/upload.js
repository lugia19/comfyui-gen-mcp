// LoRA upload, the one way a LoRA comes in: open a session, send the file in chunks, each answered
// with its MD5 (R2's ETag for the part, or the extension's own) which must match ours, then finish
// with the list of parts. On a Worker the chunks go through it into R2, and from there to every GPU;
// on the extension's page, into this computer's LoRAs folder.
import { api } from './api.js'
import { md5 } from './md5.js'

const PARALLEL = 3
const RETRIES = 5

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The calls after the chunks (finish) are safe to repeat: ride out a dropped connection instead of
// losing an upload that already arrived. HTTP errors are final.
async function apiRetrying(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api(method, path, body)
    } catch (e) {
      if (e.status || attempt >= RETRIES) throw e
      await sleep(1000 * 2 ** attempt)
    }
  }
}

/** PUT one chunk until it arrives intact: its ETag. */
async function putChunk(url, buf, hash) {
  for (let attempt = 0; ; attempt++) {
    let status = 0
    let message = ''
    try {
      const resp = await fetch(url, { method: 'PUT', body: buf })
      status = resp.status
      const data = await resp.json().catch(() => ({}))
      if (resp.ok && data.etag === hash) return data.etag
      message = resp.ok ? 'the chunk arrived damaged' : data.error || `HTTP ${status}`
      if (resp.ok) status = 0 // damaged on the way: send it again
    } catch (e) {
      message = e.message // network error: retry
    }
    // A 4xx other than a timeout is the request's fault: retrying cannot help.
    const fatal = status >= 400 && status < 500 && status !== 408 && status !== 429
    if (fatal || attempt >= RETRIES) throw new Error(message)
    await sleep(1000 * 2 ** attempt)
  }
}

/**
 * Upload *file* as a LoRA, for the LoRA group *group* (the server files it there). *onProgress*
 * gets {phase: 'upload', done, total} in bytes. Resolves when the file is stored; throws an Error
 * with the reason otherwise.
 */
export async function uploadLora(file, onProgress, group) {
  const session = await api('POST', '/loras/uploads', { filename: file.name, size: file.size })
  const { id, chunk_size: chunkSize, chunks, upload_url: url } = session
  const parts = []
  let sent = 0
  let next = 0
  onProgress({ phase: 'upload', done: 0, total: file.size })

  async function worker() {
    while (next < chunks) {
      const index = next++
      const buf = await file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize)).arrayBuffer()
      parts.push({ index, etag: await putChunk(`${url}/${index}`, buf, md5(buf)) })
      sent += buf.byteLength
      onProgress({ phase: 'upload', done: sent, total: file.size })
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks) }, worker))

  const done = await apiRetrying('POST', `/loras/uploads/${id}/finish`, { parts, group })
  if (done.state === 'failed') throw new Error(done.error || 'the upload could not be finished')
}
