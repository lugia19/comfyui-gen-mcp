<script>
  import { onMount } from 'svelte'
  import { api, ApiError } from './lib/api.js'
  import Login from './lib/Login.svelte'
  import AgentWorker from './lib/AgentWorker.svelte'
  import Checklist from './lib/Checklist.svelte'
  import LocalSetup from './lib/LocalSetup.svelte'
  import Setup from './lib/Setup.svelte'
  import Settings from './lib/Settings.svelte'

  let info = $state(null) // GET /api/state, or null while logged out
  let checking = $state(true)
  let tab = $state('setup')

  // Settings pages, one per backend: the Worker's PC and Modal (or ComfyUI URL) each have their
  // own. The extension has one, for this computer. #settings-<target> opens one directly.
  let settingsTabs = $derived(
    !info || info.mode === 'agent' ? []
    : info.mode === 'local' ? [['machine', 'Settings']]
    : [
        ...(info.pc?.paired ? [['pc', 'Settings [Local]']] : []),
        ...(info.generator?.kind === 'modal' ? [['modal', 'Settings [Modal]']] : []),
        ...(info.generator?.kind === 'url' ? [['url', 'Settings [Remote]']] : []),
      ],
  )

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

  // The machine pages' checklist: the agent pairs and installs; the extension only installs.
  let installed = $derived(local && info.comfyui.state !== 'not_installed')
  let checklist = $derived(
    !local ? []
    : [
        ...(agent
          ? [{ title: 'Pair with your Worker', done: info.worker.state === 'connected', hint: info.worker.paired ? 'Waiting for the Worker to accept the connection.' : "Paste the pairing link from your Worker's page below." }]
          : []),
        { title: 'Install ComfyUI', done: installed, hint: 'Choose your GPU below and click Install. It takes a few minutes.' },
      ],
  )

  async function loggedIn() {
    await refresh()
    // The Worker's setup is finished once Claude has connected; until then it opens on Setup.
    const ready =
      info?.mode === 'agent' ? false : info?.mode === 'local' ? info.comfyui.state !== 'not_installed' : info?.claude_seen && (info?.generator || info?.pc?.paired)
    const linked = location.hash.match(/^#settings-(\w+)$/)?.[1]
    tab = settingsTabs.some(([t]) => t === linked) ? linked : ready ? settingsTabs[0]?.[0] ?? 'setup' : 'setup'
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
  {:else if agent}
    <Checklist items={checklist} done="Ask Claude for an image, on claude.ai or the phone app: it is made on this PC." />
    <AgentWorker {info} {refresh} />
    <LocalSetup {info} {refresh} />
  {:else}
    <nav>
      <button class:active={tab === 'setup'} onclick={() => (tab = 'setup')}>Setup</button>
      {#each settingsTabs as [target, label] (target)}
        <button class:active={tab === target} onclick={() => (tab = target)}>{label}</button>
      {/each}
    </nav>
    {#if tab === 'setup'}
      {#if local}
        <Checklist items={checklist} done="Ask Claude Desktop for an image." />
        <LocalSetup {info} {refresh} />
      {:else}<Setup {info} {refresh} />{/if}
    {:else}
      {#key tab}<Settings {info} {refresh} target={tab} />{/key}
    {/if}
  {/if}
</main>
