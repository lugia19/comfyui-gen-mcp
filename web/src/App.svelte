<script>
  import { onMount } from 'svelte'
  import { api, ApiError, pcPage, workerApi } from './lib/api.js'
  import Login from './lib/Login.svelte'
  import AgentWorker from './lib/AgentWorker.svelte'
  import Checklist from './lib/Checklist.svelte'
  import ConnectModal from './lib/ConnectModal.svelte'
  import LocalSetup from './lib/LocalSetup.svelte'
  import Setup from './lib/Setup.svelte'
  import Settings from './lib/Settings.svelte'
  import SetPassword from './lib/SetPassword.svelte'
  import Update from './lib/Update.svelte'
  import AgentUpdate from './lib/AgentUpdate.svelte'
  import { Task } from './lib/task.svelte.js'

  let info = $state(null) // GET /api/state, or null while logged out
  let checking = $state(true)
  let tab = $state('setup')

  // One Settings page, for every GPU the Worker has (or for this computer, on the extension), once
  // there is something to set up. #settings opens it directly.
  let hasSettings = $derived(Boolean(info) && info.mode !== 'agent' && (info.mode === 'local' || Boolean(info.gpus?.length)))

  // A PC's own page on the Worker (/gpu/<id>): the agent's page, relayed. Its name comes from the
  // Worker's GPU list; *pcTrouble* is why the PC can't be reached (offline, say), with a retry.
  let pcName = $state(pcPage)
  let pcTrouble = $state('')

  async function refresh() {
    try {
      if (pcPage) {
        const worker = await workerApi('GET', '/state') // logged in? and the PC's name
        pcName = worker.gpus?.find((g) => g.id === pcPage)?.name ?? pcPage
      }
      info = await api('GET', '/state')
      pcTrouble = ''
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) info = null
      else if (pcPage && e instanceof ApiError) pcTrouble = e.message
      else throw e
    } finally {
      checking = false
    }
  }
  // While the PC can't be reached, look again every 10 s.
  $effect(() => {
    if (!pcTrouble) return
    const t = setInterval(() => refresh().catch(() => {}), 10_000)
    return () => clearInterval(t)
  })

  // The Worker's pages sit behind a login; the Claude Desktop extension's (mode "local") answer
  // only on this computer, so they have none.
  // mode "agent": the PC agent's page, its machine and its Worker; the pack settings are on the Worker.
  let local = $derived(info?.mode === 'local' || info?.mode === 'agent')
  let agent = $derived(info?.mode === 'agent')
  // The Worker's pages are full-window (wizard.css): its login and Setup are wizards, Settings has a
  // section bar. The header stays on top and the page under it uses the whole width. --app-top is
  // the header's height, for what sticks below it.
  let wide = $derived(!checking && !local && (!info || !info.needs_password))
  let topH = $state(0)

  // Three pages look alike (the Worker's, the agent's, the extension's): their tabs say which.
  $effect(() => {
    document.title = pcPage ? `${pcName}: Comfy-Gen` : agent ? 'Comfy-Gen agent' : info?.mode === 'local' ? 'Comfy-Gen extension' : 'Comfy-Gen Worker'
  })

  // The machine pages' checklist: the agent pairs and installs; the extension only installs.
  let installed = $derived(local && info.comfyui.state !== 'not_installed')
  let checklist = $derived(
    !local ? []
    : [
        ...(agent && !pcPage
          ? [{ title: 'Pair with your Worker', done: info.worker.state === 'connected', hint: !info.worker.paired ? "On your Worker's page, click Pair with the agent. Or copy its pairing link and paste it below." : info.worker.state === 'refused' ? 'The Worker refused this link. Paste a new link below.' : 'Waiting for the Worker to accept the connection.' }]
          : []),
        { title: 'Install ComfyUI', done: installed, hint: 'Choose your graphics card below. Then click Install ComfyUI. It takes a few minutes.' },
      ],
  )

  async function loggedIn() {
    await refresh()
    // The Worker's setup is finished once Claude has connected; until then it opens on Setup.
    const ready =
      info?.mode === 'agent' ? false : info?.mode === 'local' ? info.comfyui.state !== 'not_installed' : info?.claude_seen && info?.gpus?.length
    tab = hasSettings && (ready || location.hash.startsWith('#settings')) ? 'settings' : 'setup'
  }

  // #settings/<section> names the Settings section open; Setup has none.
  let unsaved = $state(false) // Settings has changes waiting for Save
  function show(t) {
    if (t === tab) return
    if (unsaved && !confirm('Leave Settings? Your unsaved changes will be lost.')) return
    unsaved = false
    tab = t
    if (t === 'setup' && location.hash.startsWith('#settings')) history.replaceState(null, '', location.pathname)
    window.scrollTo(0, 0)
  }
  const openSettings = () => show('settings')

  async function logout() {
    await api('POST', '/logout')
    info = null
  }

  // #ticket=…: the setup site created this Worker (or logged in to it) and sent the browser here
  // with a one-use login (design §6). An expired one leaves the usual login.
  let ticketError = $state('')
  async function useTicket() {
    const m = /^#ticket=([\w-]+)$/.exec(location.hash)
    if (!m) return
    history.replaceState(null, '', location.pathname)
    try {
      await api('POST', '/login', { ticket: m[1] })
    } catch (e) {
      ticketError = e.message
    }
  }

  // The Worker's Cloudflare connection is gone (revoked, or unused too long): logging in with
  // Cloudflare again hands it new access, and comes back here.
  const reconnect = new Task()
  const startReconnect = () => reconnect.run(async () => (location.href = (await api('POST', '/login/cloudflare')).url))

  // An install made from a GitHub copy (update path "build") moves to the new setup the same way:
  // the setup site uploads the latest release over it and hands it the access, and it comes back
  // here with the move's note (what's left to delete in GitHub), shown until dismissed.
  const move = new Task()
  const startMove = () => move.run(async () => (location.href = (await api('POST', '/cloudflare/move')).url))
  const NOTE_SEEN = 'comfy-gen-move-note'
  let noteSeen = $state((() => { try { return localStorage.getItem(NOTE_SEEN) } catch { return null } })())
  function dismissNote() {
    noteSeen = info.move_note
    try { localStorage.setItem(NOTE_SEEN, noteSeen) } catch {}
  }

  // After a move, Modal's token is still only in the old build's secrets: Modal keeps running, but
  // updates pass it over until it is connected here.
  let modalUnlinked = $derived(info?.update_path === 'oauth' && !info.modal_connected && (info.gpus ?? []).some((g) => g.kind === 'modal'))

  onMount(async () => {
    await useTicket()
    await loggedIn()
  })
</script>

<!-- The Setup / Settings tabs: in the header on a wide window, above the page on a narrow one. -->
{#snippet tabs()}
  <nav>
    <button class:active={tab === 'setup'} onclick={() => show('setup')}>Setup</button>
    {#if hasSettings}
      <button class:active={tab === 'settings'} onclick={() => show('settings')}>Settings</button>
    {/if}
  </nav>
{/snippet}

<main class:wide style="--app-top: {wide ? topH : 0}px">
  <div class="app-top" bind:offsetHeight={topH}>
  <header>
    {#if pcPage && (info || pcTrouble)}
      <div class="pc-title">
        <a href="/#settings/gpus">‹ Your Worker</a>
        <h1>{pcName}</h1>
      </div>
    {:else}
      <h1>Comfy-Gen-MCP</h1>
    {/if}
    {#if wide && info}
      {@render tabs()}
    {/if}
    {#if info}
      <div class="row">
        {#if !local && !info.needs_password}<Update {info} {refresh} />
        {:else if agent}<AgentUpdate version={info.version} call={api} showVersion reload />
        {:else}<span class="muted">{info.version}</span>{/if}
        {#if !local}<button class="secondary" onclick={logout}>Log out</button>{/if}
      </div>
    {/if}
  </header>
  {#if info && !local && !info.needs_password}
    {#if info.cf_lost}
      <p class="banner warn">
        <span>Your Worker lost its connection to Cloudflare, so it can't update itself.</span>
        <button class="small" onclick={startReconnect} disabled={reconnect.busy}>Reconnect Cloudflare</button>
        {#if reconnect.error}<span class="err">{reconnect.error}</span>{/if}
      </p>
    {/if}
    {#if info.update_path === 'build'}
      <p class="banner">
        <span>This Worker updates from its copy of Comfy-Gen on GitHub. Move it to the new setup: it then updates itself, and keeps its address, images and settings.</span>
        <button class="small" onclick={startMove} disabled={move.busy}>Move to the new setup</button>
        {#if move.error}<span class="err">{move.error}</span>{/if}
      </p>
    {/if}
    {#if info.move_note && info.move_note !== noteSeen}
      <p class="banner">
        <span>{info.move_note}</span>
        <button class="small secondary" onclick={dismissNote}>Got it</button>
      </p>
    {/if}
    {#if modalUnlinked}
      <p class="banner">
        <span>Connect Modal, so Modal is updated with your Worker. Until then, it keeps running the version it has.</span>
        <ConnectModal {refresh} small />
      </p>
    {/if}
  {/if}
  </div>

  {#if checking}
    <p class="muted">{pcPage ? `Asking ${pcName}…` : 'Loading…'}</p>
  {:else if pcPage && pcTrouble && !info}
    <section>
      <h2>{pcName} can't be reached</h2>
      <p>{pcTrouble}</p>
      <p class="muted">This page tries again every 10 seconds.</p>
      <button onclick={() => refresh().catch(() => {})}>Try again</button>
    </section>
  {:else if !info}
    <Login onlogin={loggedIn} notice={ticketError} />
  {:else if !local && info.needs_password}
    <!-- Required once, right after the first (token) login. -->
    <section><SetPassword required ondone={loggedIn} /></section>
  {:else if agent && pcPage}
    <!-- The PC's page through the Worker: its machine settings, unfolded; pairing stays on the PC. -->
    {#if pcTrouble}<p class="err">{pcTrouble}</p>{/if}
    <Checklist items={checklist} done="Ask Claude for an image on claude.ai or in the phone app. The image is made on this PC." />
    <LocalSetup {info} {refresh} />
  {:else if agent}
    <Checklist items={checklist} done="Ask Claude for an image on claude.ai or in the phone app. The image is made on this PC. You can close this page. The agent keeps running, with its icon in the tray." />
    <AgentWorker {info} {refresh} />
    {#if info.worker.state === 'connected' && info.comfyui.state !== 'not_installed'}
      <!-- Managed from the Worker's page now (Setup, Set up your PC, Manage ComfyUI); kept here for when
           it can't be reached, and for the folder settings that stay on this PC. -->
      <details class="pc-settings">
        <summary>This PC's ComfyUI and folders</summary>
        <LocalSetup {info} {refresh} />
      </details>
    {:else}
      <LocalSetup {info} {refresh} />
    {/if}
  {:else}
    {#if !wide}
      {@render tabs()}
    {/if}
    {#if tab === 'setup'}
      {#if local}
        <Checklist items={checklist} done="Ask Claude Desktop for an image. You can close this page: the tray icon opens it again." />
        <LocalSetup {info} {refresh} />
      {:else}<Setup {info} {refresh} onsettings={hasSettings ? openSettings : null} />{/if}
    {:else}
      <Settings {info} {refresh} onsetup={() => show('setup')} bind:unsaved />
    {/if}
  {/if}
</main>

<style>
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin: 0;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  .warn {
    border-bottom-color: var(--err);
  }
</style>
