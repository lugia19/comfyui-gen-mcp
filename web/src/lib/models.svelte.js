import { api } from './api.js'

// The download state of the selected packs, kept fresh while a page shows it (Models.svelte on the
// Setup page, the model cards in Settings). On the Worker a pack has a status per GPU (each PC, the
// Modal Volume): {gpus: [{id, name}], packs: [{…, on: {gpu id: status}}]}. On this machine (the
// extension, the agent) there is one place, "here".
//
// It keeps checking while in use, since a tool call can start a download at any time. Each check
// that finds nothing new, or gets no answer, waits twice as long before the next (5 s up to 5
// minutes); any change, or a download started here, brings it back to 5 s.
export const LABEL = {
  done: 'Ready', queued: 'Queued', downloading: 'Downloading', failed: 'Failed', missing: 'Not downloaded',
  unknown: 'Unknown', offline: 'Offline',
}
export const percent = (s) => (s.total ? ` ${Math.floor((100 * (s.done || 0)) / s.total)}%` : '')

const FIRST_MS = 5000
const MAX_MS = 5 * 60 * 1000

export class ModelStatus {
  packs = $state(null) // [{name, display_name, size, on: {gpu id: status}}]
  backends = $state([]) // gpu ids, or ['here']
  names = $state({}) // gpu id -> name
  error = $state('')

  #query
  #timer = null
  #delay = FIRST_MS
  #last = ''
  #alive = false

  /** *gpu* limits the Worker's list to one GPU (the Setup page's Modal step). */
  constructor(gpu = '') {
    this.#query = gpu ? `?gpu=${gpu}` : ''
  }

  start() {
    this.#alive = true
    this.#poll()
  }

  stop() {
    this.#alive = false
    clearTimeout(this.#timer)
  }

  /** The status of *pack* on each GPU, or null if it isn't listed (not selected yet). */
  of(pack) {
    return this.packs?.find((p) => p.name === pack) ?? null
  }

  /** Start (or retry) a pack's download on one GPU ("here" on this machine). */
  async seed(pack, where) {
    try {
      await api('POST', '/models/seed', where === 'here' ? { pack } : { pack, gpu: where })
      clearTimeout(this.#timer)
      this.#delay = FIRST_MS
      await this.#poll()
    } catch (e) {
      this.error = e.message
    }
  }

  async #poll() {
    let changed = false
    try {
      const got = await api('GET', `/models${this.#query}`)
      const seen = JSON.stringify(got)
      changed = seen !== this.#last
      this.#last = seen
      // This machine's answer has one place: the pack's own fields are its status.
      this.backends = got.gpus ? got.gpus.map((g) => g.id) : ['here']
      this.names = Object.fromEntries((got.gpus ?? []).map((g) => [g.id, g.name]))
      this.packs = got.gpus ? got.packs : got.packs.map((p) => ({ ...p, on: { here: p } }))
      this.error = ''
    } catch (e) {
      this.error = e.message
    }
    this.#delay = changed ? FIRST_MS : Math.min(this.#delay * 2, MAX_MS)
    clearTimeout(this.#timer)
    if (this.#alive) this.#timer = setTimeout(() => this.#poll(), this.#delay) // not after the page closed mid-check
  }
}
