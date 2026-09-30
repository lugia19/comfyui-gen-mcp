<script>
  import { onDestroy, onMount } from 'svelte'
  import { api, formatBytes } from './api.js'

  // Download state of the selected packs, one row per pack. On the Worker a row has a mark per
  // backend (your PC, the Modal Volume): {backends, packs: [{…, on: {backend: status}}]}. On this
  // machine (the extension, the agent) there is one place, and the answer is {packs: [{…status}]}.
  // Saving the settings starts downloads everywhere; a missing pack can also be started here.
  //
  // It keeps checking while the page is open, since a tool call can start a download at any time.
  // Each check that finds nothing new, or gets no answer, waits twice as long before the next (5 s
  // up to 5 minutes); any change brings it back to 5 s.
  // *backend* limits the Worker's list to one (the setup page's Modal step). *onchange* hears the
  // rows after each check.
  let { local = false, backend = '', onchange = null } = $props()
  let packs = $state(null) // [{name, display_name, size, on: {backend: status}}]
  let backends = $state([])
  let error = $state('')
  let timer = null

  const FIRST_MS = 5000
  const MAX_MS = 5 * 60 * 1000
  let delay = FIRST_MS
  let last = ''
  let alive = true
  const LABEL = {
    done: 'Ready', queued: 'Queued', downloading: 'Downloading', failed: 'Failed', missing: 'Not downloaded',
    unknown: 'Unknown', offline: 'Offline',
  }
  const PLACE = { pc: 'PC', modal: 'Modal' }
  const query = backend ? `?backend=${backend}` : ''

  async function poll() {
    let changed = false
    try {
      const got = await api('GET', `/models${query}`)
      const seen = JSON.stringify(got)
      changed = seen !== last
      last = seen
      // This machine's answer has one place: the pack's own fields are its status.
      backends = got.backends ?? ['here']
      packs = got.backends ? got.packs : got.packs.map((p) => ({ ...p, on: { here: p } }))
      error = ''
      onchange?.(packs)
    } catch (e) {
      error = e.message
    }
    delay = changed ? FIRST_MS : Math.min(delay * 2, MAX_MS)
    if (alive) timer = setTimeout(poll, delay) // not after the page closed mid-check
  }

  async function start(pack, where) {
    try {
      await api('POST', '/models/seed', where === 'here' ? { pack: pack.name } : { pack: pack.name, backend: where })
      clearTimeout(timer)
      delay = FIRST_MS
      await poll()
    } catch (e) {
      error = e.message
    }
  }

  const pct = (s) => (s.total ? ` ${Math.floor((100 * (s.done || 0)) / s.total)}%` : '')

  onMount(poll)
  onDestroy(() => {
    alive = false
    clearTimeout(timer)
  })
</script>

{#if packs && packs.length}
  <h3>Models</h3>
  {#each packs as pack (pack.name)}
    <div class="model">
      <div class="row">
        <b>{pack.display_name}</b>
        <span class="muted">{formatBytes(pack.size)}</span>
      </div>
      <div class="row places">
        {#each backends as where (where)}
          {@const s = pack.on[where] ?? { state: 'unknown' }}
          <span class="place" class:ok={s.state === 'done'} class:err={s.state === 'failed'}>
            {#if PLACE[where]}<b>{PLACE[where]}</b>{/if}
            {s.state === 'done' ? '✓' : ''} {LABEL[s.state] || s.state}{s.state === 'downloading' ? pct(s) : ''}
          </span>
          {#if s.state === 'failed'}<button class="secondary" onclick={() => start(pack, where)}>Retry</button>{/if}
          {#if s.state === 'missing'}<button class="secondary" onclick={() => start(pack, where)}>Download</button>{/if}
        {/each}
      </div>
      {#if backends.length === 1 && pack.on[backends[0]].state === 'downloading' && pack.on[backends[0]].total}
        <progress max={pack.on[backends[0]].total} value={pack.on[backends[0]].done}></progress>
      {/if}
      {#each backends as where (where)}
        {#if pack.on[where]?.error}<p class="err">{PLACE[where] ? `${PLACE[where]}: ` : ''}{pack.on[where].error}</p>{/if}
      {/each}
    </div>
  {/each}
  <p class="muted">
    {#if local}Models download once into ComfyUI's models folder, or are found in a shared one.
    {:else if backends.includes('pc') && backends.includes('modal')}Models download once to your PC and to your Modal Volume.
    {:else if backends.includes('pc')}Models download once into ComfyUI's models folder on your PC.
    {:else}Models download once into your Modal Volume.{/if}
    A tool whose model is still downloading says so.
  </p>
{/if}
{#if error}<p class="err">{error}</p>{/if}

<style>
  .model { margin: 8px 0; }
  .places { gap: 6px 14px; }
  .place { white-space: nowrap; }
  .places button { margin-top: 0; }
  progress { width: 100%; }
</style>
