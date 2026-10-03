<script>
  import { onMount } from 'svelte'
  import { api, ApiError } from './lib/api.js'
  import Login from './lib/Login.svelte'
  import AgentWorker from './lib/AgentWorker.svelte'
  import Checklist from './lib/Checklist.svelte'
  import LocalSetup from './lib/LocalSetup.svelte'
  import Setup from './lib/Setup.svelte'
  import Settings from './lib/Settings.svelte'
  import SetPassword from './lib/SetPassword.svelte'

  let info = $state(null) // GET /api/state, or null while logged out
  let checking = $state(true)
  let tab = $state('setup')

  // One Settings page, for every GPU the Worker has (or for this computer, on the extension), once
  // there is something to set up. #settings opens it directly.
  let hasSettings = $derived(Boolean(info) && info.mode !== 'agent' && (info.mode === 'local' || Boolean(info.gpus?.length)))

  async function refresh() {
    try {
      info = await api('GET', '/state')
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e
      info = null
    } finally {
      checking = false
    }
  }

  // The Worker's pages sit behind a login; the Claude Desktop extension's (mode "local") answer
  // only on this computer, so they have none.
  // mode "agent": the PC agent's page, its machine and its Worker; the pack settings are on the Worker.
  let local = $derived(info?.mode === 'local' || info?.mode === 'agent')
  let agent = $derived(info?.mode === 'agent')
  // Three pages look alike (the Worker's, the agent's, the extension's): their tabs say which.
  $effect(() => {
    document.title = agent ? 'Comfy-Gen agent' : info?.mode === 'local' ? 'Comfy-Gen extension' : 'Comfy-Gen Worker'
  })

  // The machine pages' checklist: the agent pairs and installs; the extension only installs.
  let installed = $derived(local && info.comfyui.state !== 'not_installed')
  let checklist = $derived(
    !local ? []
    : [
        ...(agent
          ? [{ title: 'Pair with your Worker', done: info.worker.state === 'connected', hint: !info.worker.paired ? "Paste the pairing link from your Worker's page below." : info.worker.state === 'refused' ? 'The Worker refused this link: paste a new one below.' : 'Waiting for the Worker to accept the connection.' }]
          : []),
        { title: 'Install ComfyUI', done: installed, hint: 'Choose your GPU below and click Install. It takes a few minutes.' },
      ],
  )

  async function loggedIn() {
    await refresh()
    // The Worker's setup is finished once Claude has connected; until then it opens on Setup.
    const ready =
      info?.mode === 'agent' ? false : info?.mode === 'local' ? info.comfyui.state !== 'not_installed' : info?.claude_seen && info?.gpus?.length
    tab = hasSettings && (ready || location.hash === '#settings') ? 'settings' : 'setup'
  }

  async function logout() {
    await api('POST', '/logout')
    info = null
  }

  onMount(loggedIn)
</script>

<main>
  <header>
    <h1>Comfy-Gen-MCP</h1>
    {#if info}
      <div class="row">
        <span class="muted">{info.version}</span>
        {#if !local}<button class="secondary" onclick={logout}>Log out</button>{/if}
      </div>
    {/if}
  </header>

  {#if checking}
    <p class="muted">Loading…</p>
  {:else if !info}
    <Login onlogin={loggedIn} />
  {:else if !local && !info.password_set}
    <!-- Required once, right after the first (token) login. -->
    <section><SetPassword required ondone={loggedIn} /></section>
  {:else if agent}
    <Checklist items={checklist} done="Ask Claude for an image, on claude.ai or the phone app: it is made on this PC." />
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
    <nav>
      <button class:active={tab === 'setup'} onclick={() => (tab = 'setup')}>Setup</button>
      {#if hasSettings}
        <button class:active={tab === 'settings'} onclick={() => (tab = 'settings')}>Settings</button>
      {/if}
    </nav>
    {#if tab === 'setup'}
      {#if local}
        <Checklist items={checklist} done="Ask Claude Desktop for an image." />
        <LocalSetup {info} {refresh} />
      {:else}<Setup {info} {refresh} />{/if}
    {:else}
      <Settings {info} {refresh} />
    {/if}
  {/if}
</main>
