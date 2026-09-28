<script>
  import { onMount } from 'svelte'
  import { api, ApiError } from './lib/api.js'
  import Login from './lib/Login.svelte'
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

  async function loggedIn() {
    await refresh()
    tab = info && info.generator ? 'settings' : 'setup'
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
        <button class="secondary" onclick={logout}>Log out</button>
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
      <Setup {info} {refresh} />
    {:else}
      <Settings {info} {refresh} />
    {/if}
  {/if}
</main>
