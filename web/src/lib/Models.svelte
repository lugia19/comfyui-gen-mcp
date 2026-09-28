<script>
  import { onDestroy, onMount } from 'svelte'
  import { api, formatBytes } from './api.js'

  // Download state of the selected packs on the Modal Volume. Polls while anything is in flight.
  let packs = $state(null)
  let error = $state('')
  let timer = null

  const BUSY = ['queued', 'downloading', 'missing', 'unknown']
  const LABEL = { done: 'Ready', queued: 'Queued', downloading: 'Downloading', failed: 'Failed', missing: 'Not downloaded', unknown: 'Unknown' }

  async function poll() {
    try {
      packs = (await api('GET', '/models')).packs
      error = ''
    } catch (e) {
      error = e.message
    }
    if (!packs || packs.some((p) => BUSY.includes(p.state))) timer = setTimeout(poll, 5000)
  }

  async function retry(pack) {
    try {
      await api('POST', '/models/seed', { pack: pack.name })
      clearTimeout(timer)
      await poll()
    } catch (e) {
      error = e.message
    }
  }

  onMount(poll)
  onDestroy(() => clearTimeout(timer))
</script>

{#if packs && packs.length}
  <h3>Models on your GPU</h3>
  {#each packs as pack (pack.name)}
    <div class="model">
      <div class="row">
        <b>{pack.display_name}</b>
        <span class="muted">{formatBytes(pack.size)}</span>
        <span class:ok={pack.state === 'done'} class:err={pack.state === 'failed'}>{LABEL[pack.state] || pack.state}</span>
        {#if pack.state === 'failed'}<button class="secondary" onclick={() => retry(pack)}>Retry</button>{/if}
      </div>
      {#if pack.state === 'downloading' && pack.total}
        <progress max={pack.total} value={pack.done}></progress>
      {/if}
      {#if pack.error}<p class="err">{pack.error}</p>{/if}
    </div>
  {/each}
  <p class="muted">Models download once into your Modal Volume. A tool whose model is still downloading says so.</p>
{/if}
{#if error}<p class="err">{error}</p>{/if}

<style>
  .model { margin: 8px 0; }
  progress { width: 100%; }
</style>
