<script>
  import { onDestroy, onMount } from 'svelte'
  import { api } from './api.js'

  // The agent's link to a Worker: paste the pairing link from the Worker's settings page, see the
  // connection, unpair.
  let { info, refresh } = $props()

  let worker = $derived(info.worker)
  let link = $state('')
  let busy = $state(false)
  let error = $state('')
  let timer = null

  const LABEL = {
    connected: 'Connected',
    connecting: 'Connecting…',
    refused: 'Refused by the Worker',
    unpaired: 'Not paired',
  }

  async function pair(e) {
    e.preventDefault()
    busy = true
    error = ''
    try {
      await api('POST', '/pair', { link: link.trim() })
      link = ''
      await refresh()
    } catch (err) {
      error = err.message
    } finally {
      busy = false
    }
  }

  async function unpair() {
    if (!confirm('Disconnect this PC from the Worker? Paste a pairing link again to reconnect.')) return
    await api('DELETE', '/pair')
    await refresh()
  }

  function poll() {
    timer = setTimeout(async () => {
      if (worker?.paired && worker.state !== 'connected') await refresh().catch(() => {})
      poll()
    }, 3000)
  }
  onMount(poll)
  onDestroy(() => clearTimeout(timer))
</script>

<section>
  <h2>Your Worker</h2>
  {#if worker.paired}
    <p>
      <b class:ok={worker.state === 'connected'} class:err={worker.state === 'refused'}>{LABEL[worker.state] || worker.state}</b>
      <span class="muted">to <code>{worker.url}</code></span>
    </p>
    {#if worker.error}<p class="err">{worker.error}</p>{/if}
    {#if worker.paused}
      <p><b>Paused:</b> not taking image requests. Take them again from the Comfy-Gen tray icon.</p>
    {/if}
    <p class="muted">Claude (claude.ai, the phone app) generates on this PC through your Worker while it is connected.</p>
    <p>
      <a class="button" href="{worker.url}/#settings" target="_blank" rel="noopener">Edit settings</a>
    </p>
    <p class="muted">
      Models, styles and LoRAs are set on your Worker's page, under Settings, for this PC and Modal alike. LoRAs you
      turn on there are copied between this PC and Modal.
    </p>
  {:else}
    <p>
      Pair this PC with your Worker: on the Worker's page, the step <b>Run the agent on your PC</b> shows
      the pairing link. Copy it and paste it here.
    </p>
  {/if}
  <form onsubmit={pair}>
    <label for="link">{worker.paired ? 'Pair again with a new link' : 'Pairing link'}</label>
    <input id="link" type="text" bind:value={link} placeholder="https://…workers.dev/agent#…" autocomplete="off" />
    <button type="submit" disabled={busy || !link.trim()}>{busy ? 'Pairing…' : 'Pair'}</button>
    {#if worker.paired}<button type="button" class="secondary" onclick={unpair}>Unpair</button>{/if}
  </form>
  {#if error}<p class="err">{error}</p>{/if}
</section>
