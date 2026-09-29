<script>
  import { onMount } from 'svelte'
  import { api, ApiError } from './lib/api.js'
  import Login from './lib/Login.svelte'
  import LocalSetup from './lib/LocalSetup.svelte'
  import Setup from './lib/Setup.svelte'
  import Settings from './lib/Settings.svelte'

  let info = $state(null) // GET /api/state, or null while logged out
  let checking = $state(true)
  let tab = $state('setup')

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
  let local = $derived(info?.mode === 'local')

  async function loggedIn() {
    await refresh()
    const ready = info?.mode === 'local' ? info.comfyui.state !== 'not_installed' : info?.generator
    tab = ready ? 'settings' : 'setup'
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
  {:else}
    <nav>
      <button class:active={tab === 'setup'} onclick={() => (tab = 'setup')}>Setup</button>
      <button class:active={tab === 'settings'} onclick={() => (tab = 'settings')}>Settings</button>
    </nav>
    {#if tab === 'setup'}
      {#if local}<LocalSetup {info} {refresh} />{:else}<Setup {info} {refresh} />{/if}
    {:else}
      <Settings {info} {refresh} />
    {/if}
  {/if}
</main>
