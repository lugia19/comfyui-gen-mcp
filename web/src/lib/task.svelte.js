// The small state every page's buttons share, written once.

/** One action behind a button: *busy* while it runs (true, or the *key* it was run for: which row of
 * a list), its *error* after. */
export class Task {
  busy = $state(false)
  error = $state('')

  /** Run *fn* (async). Its error, if any, is kept in *error*; resolves to whether it worked. */
  async run(fn, key = true) {
    this.busy = key
    this.error = ''
    try {
      await fn()
      return true
    } catch (e) {
      this.error = e.message
      return false
    } finally {
      this.busy = false
    }
  }
}

/** A Copy button: *done* for a moment after it copied. */
export class Copy {
  done = $state(false)

  async copy(text) {
    await navigator.clipboard.writeText(text)
    this.done = true
    setTimeout(() => (this.done = false), 1500)
  }
}

/** A connector URL for the screen, its secret hidden (screenshots get shared). */
export const masked = (url) => (url || '').replace(/(\/mcp\/).+$/, '$1••••••••')
