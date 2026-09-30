<script>
  import { onDestroy, onMount } from 'svelte'
  import { api } from './api.js'

  // The Worker's "Your PC" section: pair a PC running the Comfy-Gen agent, see whether it is
  // connected, re-pair or unpair it. Images are generated there when it is online.
  let { info, refresh } = $props()

  let pc = $derived(info.pc)
  let busy = $state(false)
  let error = $state('')
  let copied = $state(false)
  let timer = null

  const RELEASES = 'https://github.com/lugia19/comfyui-gen-mcp/releases/latest'

  async function pair(again) {
    if (again && !confirm('Make a new pairing link? The PC paired now disconnects until you paste the new link into it.')) return
    busy = true
    error = ''
    try {
      await api('POST', '/pc/pair')
      await refresh()
    } catch (e) {
      error = e.message
    } finally {
      busy = false
    }
  }

  async function unpair() {
    if (!confirm('Unpair this PC? It disconnects, and images go to Modal (if set up) instead.')) return
    await api('DELETE', '/pc')
    await refresh()
  }

  async function copy() {
    await navigator.clipboard.writeText(pc.link)
    copied = true
    setTimeout(() => (copied = false), 1500)
  }

  // While paired but offline, check back every few seconds (the agent may be starting up).
  function poll() {
    timer = setTimeout(async () => {
      if (pc?.paired && !pc.connected) await refresh().catch(() => {})
      poll()
    }, 5000)
  }
  onMount(poll)
  onDestroy(() => clearTimeout(timer))

  const since = (t) => (t ? new Date(t).toLocaleString() : '')
</script>

<section>
  <h2>Your PC</h2>
  {#if !pc?.paired}
    <p>
      Have a GPU at home? Generate there instead: the Comfy-Gen agent runs on your PC, installs and runs
      ComfyUI, and connects out to this Worker, so nothing on your PC is exposed to the internet.
      {#if info.generator?.kind === 'modal'}While the PC is off, Modal takes over.{/if}
    </p>
    <button onclick={() => pair(false)} disabled={busy}>{busy ? 'Making a link…' : 'Pair a PC'}</button>
  {:else}
    <p>
      {#if pc.connected}
        <b class="ok">Connected</b> <span class="muted">since {since(pc.since)}</span>
      {:else}
        <b class="err">Offline</b> <span class="muted">{info.generator?.kind === 'modal' ? 'Images go to Modal until it is back.' : 'Start the PC, or check the agent’s tray icon.'}</span>
      {/if}
    </p>
    {#if pc.connected && pc.info}
      <p class="muted">
        Agent {pc.info.version} on {pc.info.platform}{#if pc.info.gpu}, GPU: {pc.info.gpu}{/if}{#if pc.info.comfyui}, ComfyUI {String(pc.info.comfyui).replace('_', ' ')} when it connected{/if}.
      </p>
    {/if}
    <ol>
      <li>Download the Comfy-Gen agent for your system from the <a href={RELEASES} target="_blank" rel="noopener">latest release</a> and run it. It starts with your PC from then on.</li>
      <li>Its settings page opens: paste this pairing link there.</li>
    </ol>
    <div class="row"><code>{pc.link}</code></div>
    <div class="row">
      <button onclick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
      <button class="secondary" onclick={() => pair(true)} disabled={busy}>New link</button>
      <button class="secondary" onclick={unpair}>Unpair</button>
    </div>
    <p class="muted">The link lets a PC generate for this Worker. Treat it like a password.</p>
  {/if}
  {#if error}<p class="err">{error}</p>{/if}
</section>
