<script>
  import { onDestroy, onMount } from 'svelte'
  import { api } from './api.js'
  import OpenButton from './OpenButton.svelte'
  import { Task } from './task.svelte.js'

  // The agent's link to a Worker: paste the pairing link from the Worker's settings page, see the
  // connection, unpair.
  let { info, refresh } = $props()

  let worker = $derived(info.worker)
  let link = $state('')
  const pairing = new Task()
  let timer = null

  const LABEL = {
    connected: 'Connected',
    connecting: 'Connecting…',
    refused: 'Refused',
    unpaired: 'Not paired',
  }

  // A whole pairing link pasted pairs at once: https (or this machine), /agent, and its secret after
  // # (the agent's parsePairingLink checks the same, and says what is wrong).
  function looksLikeLink(text) {
    try {
      const u = new URL(text.trim())
      return (u.protocol === 'https:' || /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(u.host)) && u.pathname === '/agent' && u.hash.length > 32
    } catch {
      return false
    }
  }
  function linkInput() {
    if (looksLikeLink(link) && !pairing.busy) pair()
  }

  function pair(e) {
    e?.preventDefault()
    pairing.run(async () => {
      await api('POST', '/pair', { link: link.trim() })
      link = ''
      await refresh()
    })
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
      <span class="muted">{worker.state === 'refused' ? 'by' : 'to'} <code>{worker.url}</code></span>
    </p>
    {#if worker.error}<p class="err">{worker.error}</p>{/if}
    {#if worker.paused}
      <p><b>Paused:</b> not taking image requests. Take them again from the Comfy-Gen tray icon.</p>
    {/if}
    <p>Claude makes images on this PC through your Worker while it is connected.</p>
    <p><OpenButton href="{worker.url}/#settings" label="Open your Worker's settings" /></p>
    <p class="muted">Models, styles and LoRAs are set there, for all your GPUs alike.</p>
    <p>
      <b>Don't also install the Claude Desktop extension on this PC:</b> two don't fit on one graphics card. Claude Desktop
      can use your Worker instead.
    </p>
  {:else}
    <p>
      On your Worker's page, in <b>Set up your PC</b>, click <b>Copy link</b>, then paste the link here: it pairs by itself.
      (No link there? Click <b>Add a PC</b> first.)
    </p>
  {/if}
  <form onsubmit={pair}>
    <label for="link">{worker.paired ? 'Pair again with a new link' : 'Pairing link'}</label>
    <input id="link" type="text" bind:value={link} oninput={linkInput} placeholder="https://…workers.dev/agent#…" autocomplete="off" disabled={pairing.busy} />
    <button type="submit" disabled={pairing.busy || !link.trim()}>{pairing.busy ? 'Pairing…' : 'Pair'}</button>
    {#if worker.paired}<button type="button" class="secondary" onclick={unpair}>Unpair</button>{/if}
  </form>
  {#if pairing.error}<p class="err">{pairing.error}</p>{/if}
</section>
