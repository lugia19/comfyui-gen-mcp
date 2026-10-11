<script>
  import { onDestroy, onMount, untrack } from 'svelte'
  import { formatBytes } from './api.js'
  import { LABEL, ModelStatus, percent } from './models.svelte.js'

  // Download state of the selected packs, one row per pack (models.svelte.js keeps it fresh): on the
  // Worker a mark per GPU, on this machine one. A missing pack can be started here.
  // *gpu* limits the Worker's list to one (the setup page's Modal step). *onchange* hears the rows
  // after each check.
  let { local = false, gpu = '', onchange = null } = $props()
  const status = untrack(() => new ModelStatus(gpu)) // which GPU is fixed for the component's life
  let packs = $derived(status.packs)
  let backends = $derived(status.backends)
  let names = $derived(status.names)
  let error = $derived(status.error)
  $effect(() => {
    if (packs) onchange?.(packs)
  })
  const start = (pack, where) => status.seed(pack.name, where)
  const pct = percent

  onMount(() => status.start())
  onDestroy(() => status.stop())
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
            {#if names[where] && backends.length > 1}<b>{names[where]}</b>{/if}
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
        {#if pack.on[where]?.error}<p class="err">{names[where] ? `${names[where]}: ` : ''}{pack.on[where].error}</p>{/if}
      {/each}
    </div>
  {/each}
  <p class="muted">
    {#if local}Models download once into ComfyUI's models folder, or are found in a shared one.
    {:else}Models download once to each GPU: a PC's ComfyUI models folder, or your Modal Volume.{/if}
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
