<script>
  import { onMount } from 'svelte'
  import { api } from './api.js'
  import LocalSetup from './LocalSetup.svelte'

  // A paired PC's own settings, managed from the Worker's page (design §9, "One settings page"): its
  // ComfyUI (state, start and stop, install) and the models found on it, through the relay. Folder
  // paths and a ComfyUI of your own stay on the PC's own page.
  let { id } = $props()

  let base = $derived(`/gpus/${id}/machine`)
  let info = $state(null)
  let error = $state('')

  async function refresh() {
    try {
      info = await api('GET', `${base}/state`)
      error = ''
    } catch (e) {
      error = e.message
    }
  }

  onMount(refresh)
</script>

<div class="manage">
  {#if info}
    <LocalSetup {info} {refresh} {base} remote />
  {:else if error}
    <p class="err">{error}</p>
  {:else}
    <p class="muted">Asking the PC…</p>
  {/if}
</div>

<style>
  .manage { border-left: 3px solid var(--border); padding-left: 12px; margin-top: 8px; }
  .manage :global(section) { margin: 8px 0; padding: 0; border: 0; box-shadow: none; }
  .manage :global(h2) { font-size: 16px; }
</style>
