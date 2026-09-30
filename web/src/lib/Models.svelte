<script>
  import { onDestroy, onMount } from 'svelte'
  import { api, formatBytes } from './api.js'

  // Download state of the selected packs: on the Modal Volume, or (local) in ComfyUI's models
  // folder. Locally a missing pack waits for a click (or a tool call); on Modal the Worker starts it.
  //
  // It keeps checking while the page is open, since a tool call can start a download at any time.
  // Each check that finds nothing new, or gets no answer, waits twice as long before the next (5 s
  // up to 5 minutes); any change brings it back to 5 s. Each check is a Worker round trip to the
  // PC or to Modal.
  // *path*: /models (this machine, or Modal), or /pc/models (the paired PC, through the Worker).
  // *onchange* hears the packs after each check (the setup page ticks its models step with it).
  let { local = false, path = '/models', title = '', onchange = null } = $props()
  let packs = $state(null)
  let error = $state('')
  let timer = null

  const FIRST_MS = 5000
  const MAX_MS = 5 * 60 * 1000
  let delay = FIRST_MS
  let last = ''
  let alive = true
  const LABEL = { done: 'Ready', queued: 'Queued', downloading: 'Downloading', failed: 'Failed', missing: 'Not downloaded', unknown: 'Unknown' }

  async function poll() {
    let changed = false
    try {
      const got = (await api('GET', path)).packs
      const seen = JSON.stringify(got)
      changed = seen !== last
      last = seen
      packs = got
      error = ''
      onchange?.(packs)
    } catch (e) {
      error = e.message
    }
    delay = changed ? FIRST_MS : Math.min(delay * 2, MAX_MS)
    if (alive) timer = setTimeout(poll, delay) // not after the page closed mid-check
  }

  async function retry(pack) {
    try {
      await api('POST', `${path}/seed`, { pack: pack.name })
      clearTimeout(timer)
      delay = FIRST_MS
      await poll()
    } catch (e) {
      error = e.message
    }
  }

  onMount(poll)
  onDestroy(() => {
    alive = false
    clearTimeout(timer)
  })
</script>

{#if packs && packs.length}
  <h3>{title || (local ? 'Models' : 'Models on your GPU')}</h3>
  {#each packs as pack (pack.name)}
    <div class="model">
      <div class="row">
        <b>{pack.display_name}</b>
        <span class="muted">
          {formatBytes(pack.size)}{#if pack.state !== 'done' && pack.total && pack.total < pack.size}, {formatBytes(pack.total)} still to download{/if}
        </span>
        <span class:ok={pack.state === 'done'} class:err={pack.state === 'failed'}>{LABEL[pack.state] || pack.state}</span>
        {#if pack.state === 'failed'}<button class="secondary" onclick={() => retry(pack)}>Retry</button>{/if}
        {#if local && pack.state === 'missing'}<button class="secondary" onclick={() => retry(pack)}>Download</button>{/if}
      </div>
      {#if pack.state === 'downloading' && pack.total}
        <progress max={pack.total} value={pack.done}></progress>
      {/if}
      {#if pack.error}<p class="err">{pack.error}</p>{/if}
    </div>
  {/each}
  <p class="muted">
    {local ? "Models download once into ComfyUI's models folder, or are found in a shared one." : 'Models download once into your Modal Volume.'}
    A tool whose model is still downloading says so.
  </p>
{/if}
{#if error}<p class="err">{error}</p>{/if}

<style>
  .model { margin: 8px 0; }
  progress { width: 100%; }
</style>
