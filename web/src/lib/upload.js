// LoRA upload, the one way a LoRA comes in: open a session, then send the file through core's
// sender (chunks checked against the MD5 each answer carries, then finish; the agent's push uses
// the same). On a Worker the chunks go through it into R2, and from there to every GPU; on the
// extension's page, into this computer's LoRAs folder.
import { api } from './api.js'
import { sendChunks } from '../../../packages/core/src/lora-upload.ts'

/**
 * Upload *file* as a LoRA, for the LoRA group *group* (the server files it there). *onProgress*
 * gets {phase: 'upload', done, total} in bytes. Resolves when the file is stored; throws an Error
 * with the reason otherwise.
 */
export async function uploadLora(file, onProgress, group) {
  const session = await api('POST', '/loras/uploads', { filename: file.name, size: file.size })
  onProgress({ phase: 'upload', done: 0, total: file.size })
  await sendChunks(session, {
    size: file.size,
    read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
    request: (url, init) => fetch(url, { ...init, credentials: 'same-origin' }),
    finish: { group },
    onProgress: (done) => onProgress({ phase: 'upload', done, total: file.size }),
  })
}
