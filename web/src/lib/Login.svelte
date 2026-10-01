<script>
  import { onMount } from 'svelte'
  import { api, GUIDE, hideFigure, TOKEN_TEMPLATE_URL } from './api.js'

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
  <ol>
    <li><a href={TOKEN_TEMPLATE_URL} target="_blank" rel="noopener">Open the pre-filled token page</a>. The permissions are already ticked.</li>
    <li>Click <b>Continue to summary</b>, then <b>Create Token</b>, and paste it here.</li>
  </ol>
  <figure><img src="{GUIDE}cf-token-form.png" alt="Cloudflare's Create Token page with the permissions filled in and the Continue to summary button" loading="lazy" onerror={hideFigure} /><figcaption>The pre-filled token page: scroll down and continue.</figcaption></figure>
  <figure><img src="{GUIDE}cf-token-summary.png" alt="The token summary with the Create Token button" loading="lazy" onerror={hideFigure} /><figcaption>Then Create Token.</figcaption></figure>
  <p class="muted">
    If your Cloudflare login also belongs to other accounts (an employer's, say), change "All accounts" to your own
    under <b>Account Resources</b> first, so the token cannot touch them.
  </p>
  <form onsubmit={submit}>
    <label for="token">API token</label>
    <input id="token" type="password" bind:value={token} placeholder="cfut_…" autocomplete="off" />
    <button type="submit" disabled={busy || !token.trim()}>{busy ? 'Checking…' : 'Log in'}</button>
    {#if error}<p class="err">{error}</p>{/if}
  </form>
  <p class="muted">This browser stays logged in for a year.</p>
</section>
{/if}

<style>
  figure {
    margin: 10px 0 14px;
  }
  figure img {
    display: block;
    max-width: 100%;
    height: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  figcaption {
    color: var(--muted);
    font-size: 13px;
    margin-top: 4px;
  }
</style>
