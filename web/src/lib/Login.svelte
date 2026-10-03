<script>
  import { onMount } from 'svelte'
  import { api, TOKEN_TEMPLATE_URL } from './api.js'
  import Tour from './Tour.svelte'

  // The first login is a Cloudflare token (it proves the Worker is yours); it then sets a password,
  // and later logins use that. The token stays the way back in, should the password be forgotten.
  let { onlogin } = $props()
  let token = $state('')
  let password = $state('')
  let error = $state('')
  let busy = $state(false)
  let hasPassword = $state(null) // null while asking
  let useToken = $state(false)

  onMount(async () => {
    try {
      hasPassword = (await api('GET', '/login')).password
    } catch {
      hasPassword = false
    }
  })

  async function submit(e) {
    e.preventDefault()
    busy = true
    error = ''
    try {
      await api('POST', '/login', hasPassword && !useToken ? { password } : { token: token.trim() })
      token = ''
      password = ''
      await onlogin()
    } catch (err) {
      error = err.message
    } finally {
      busy = false
    }
  }
</script>

{#if hasPassword === null}
  <p class="muted">Loading…</p>
{:else if hasPassword && !useToken}
  <section>
    <h2>Log in</h2>
    <form onsubmit={submit}>
      <label for="password">Password</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input id="password" type="password" bind:value={password} autocomplete="current-password" autofocus />
      <button type="submit" disabled={busy || !password}>{busy ? 'Checking…' : 'Log in'}</button>
      {#if error}<p class="err">{error}</p>{/if}
    </form>
    <p class="muted">
      Forgot it? <button type="button" class="link" onclick={() => ((useToken = true), (error = ''))}>Log in with a Cloudflare token instead</button>,
      then set a new one.
    </p>
  </section>
{:else}
<section>
  <h2>Log in with Cloudflare</h2>
  <p>
    {#if hasPassword}
      A Cloudflare API token that can manage this Worker proves it is yours.
      <button type="button" class="link" onclick={() => ((useToken = false), (error = ''))}>Back to the password</button>
    {:else}
      The first time, a Cloudflare API token that can manage this Worker proves it is yours. The Worker also keeps it
      to set up the GPU side and update itself. After this you set a password for next time.
    {/if}
  </p>
  <p><a class="button" href={TOKEN_TEMPLATE_URL} target="_blank" rel="noopener">Open the pre-filled token page</a></p>
  <Tour id="cf-token">
    <ol>
      <li>The permissions are already ticked. Click <b>Continue to summary</b>, then <b>Create Token</b>, and paste it here.</li>
    </ol>
    <p class="muted">
      If your Cloudflare login also belongs to other accounts (an employer's, say), change "All accounts" to your own
      under <b>Account Resources</b> first, so the token cannot touch them.
    </p>
  </Tour>
  <form onsubmit={submit}>
    <label for="token">API token</label>
    <input id="token" type="password" bind:value={token} placeholder="cfut_…" autocomplete="off" />
    <button type="submit" disabled={busy || !token.trim()}>{busy ? 'Checking…' : 'Log in'}</button>
    {#if error}<p class="err">{error}</p>{/if}
  </form>
  <p class="muted">This browser stays logged in for a year.</p>
</section>
{/if}
