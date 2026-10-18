<script>
  import { onDestroy, onMount } from 'svelte'
  import { api } from './api.js'
  import OpenButton from './OpenButton.svelte'
  import { Task } from './task.svelte.js'

  // The agent's link to a Worker: paste the pairing link from the Worker's settings page, see the
  // connection, unpair.
  let { info, refresh } = $props()
  // The Worker's settings are for after this PC's own setup: until ComfyUI is installed here, the
  // next thing to do is on this page.
  let installed = $derived(Boolean(info.comfyui?.state) && info.comfyui.state !== 'not_installed')

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
    offered = ''
    offerFrom = '' // typed or pasted: not from the button
    if (looksLikeLink(link) && !pairing.busy) pair()
  }

  // #pair=<link>: the Worker's Pair with the agent button, from its Setup page on this PC. Any page
  // can open this address, and a paired Worker can install custom nodes here (code: the agent
  // installs only Comfy-Gen's own, design §9). So it pairs at once only while unpaired (setup's
  // minute or two); a link that would replace a pairing waits for Pair, naming its Worker.
  let offered = $state('') // the Worker's address, while its link waits for Pair
  // Paired from that button: setup goes on on the Worker's page, back there once ComfyUI is installed
  // here (at once if it was already; else after the install below).
  let fromWorker = $state('') // the Worker's origin, once paired
  let offerFrom = '' // the offered link's Worker, until it pairs
  function takeOffer() {
    const m = /^#pair=(.+)$/.exec(location.hash)
    if (!m) return
    history.replaceState(null, '', location.pathname)
    try {
      const offer = decodeURIComponent(m[1])
      if (!looksLikeLink(offer)) return
      link = offer
      offerFrom = new URL(offer).origin
      if (worker.paired) offered = new URL(offer).host
      else pair()
    } catch {}
  }

  function pair(e) {
    e?.preventDefault()
    pairing.run(async () => {
      await api('POST', '/pair', { link: link.trim() })
      link = ''
      offered = ''
      fromWorker = offerFrom
      await refresh()
      if (fromWorker && installed) location.href = `${fromWorker}/`
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
  onMount(() => {
    takeOffer()
    poll()
  })
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
      <p><b>Paused:</b> this PC makes no images now. To resume, use the Comfy-Gen tray icon.</p>
    {/if}
    <p>While this PC is connected, Claude makes images on it through your Worker.</p>
    {#if fromWorker && !installed}
      <p><b>Paired.</b> Next: install ComfyUI below. Then go back to your Worker's page to finish setting up.</p>
    {:else if fromWorker}
      <p><a class="button" href="{fromWorker}/">Back to your Worker</a></p>
    {:else if installed}
      <p><OpenButton href="{worker.url}/#settings" label="Open your Worker's settings" /></p>
      <p class="muted">You choose models, styles and LoRAs there. They apply to all your GPUs.</p>
    {:else}
      <p><b>Next:</b> install ComfyUI below. Then you can finish on your Worker's page.</p>
    {/if}
    <p>
      <b>Do not also install the Claude Desktop extension on this PC.</b> One graphics card is not enough for both. Claude
      Desktop can use your Worker instead.
    </p>
  {:else if !offered}
    <p>
      On your Worker's page, go to <b>Set up your PC</b> and click <b>Pair with the agent</b>: this page then pairs
      with it by itself. Or copy the pairing link there and paste it below. If there is no link, click <b>Add a PC</b> first.
    </p>
  {/if}
  {#if offered}
    <p><b>Pair this PC with <code>{offered}</code> instead?</b> It replaces the Worker it is paired with now. Check that this is
      your Worker's address, then click <b>Pair</b>.</p>
  {/if}
  <form onsubmit={pair}>
    <label for="link">{worker.paired ? 'Pair again with a new link' : 'Pairing link'}</label>
    <input id="link" type="text" bind:value={link} oninput={linkInput} placeholder="https://…workers.dev/agent#…" autocomplete="off" disabled={pairing.busy} />
    <button type="submit" disabled={pairing.busy || !link.trim()}>{pairing.busy ? 'Pairing…' : 'Pair'}</button>
    {#if worker.paired}<button type="button" class="secondary" onclick={unpair}>Unpair</button>{/if}
  </form>
  {#if pairing.error}<p class="err">{pairing.error}</p>{/if}
</section>
