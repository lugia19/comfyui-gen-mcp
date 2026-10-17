<script>
  import { onMount } from 'svelte'
  import { api, TOKEN_TEMPLATE_URL } from './api.js'
  import OpenButton from './OpenButton.svelte'
  import Walk from './Walk.svelte'
  import WalkGuide from './WalkGuide.svelte'
  import WalkStep from './WalkStep.svelte'

  // The first login is a Cloudflare token (it proves the Worker is yours); it then sets a password,
  // and later logins use that. The token stays the way back in, should the password be forgotten.
  // *notice*: why a login link from the setup site didn't work.
  let { onlogin, notice = '' } = $props()
  let token = $state('')
  let password = $state('')
  let error = $state('')
  let busy = $state(false)
  let hasPassword = $state(null) // null while asking
  let useToken = $state(false)
  let shot = $state(false) // the token walkthrough's screenshot shows: it takes the left of the window

  onMount(async () => {
    try {
      hasPassword = (await api('GET', '/login')).password
    } catch {
      hasPassword = false
    }
  })

  // A whole token pasted logs in at once (Cloudflare's are cfut_…, or 40 characters for older ones).
  const looksLikeToken = (t) => /^cfut_\S{20,}$|^[\w-]{40,}$/.test(t.trim())
  function tokenInput() {
    if (looksLikeToken(token) && !busy) submit()
  }

  async function submit(e) {
    e?.preventDefault()
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

{#if notice}<p class="err">{notice}</p>{/if}
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
<section class="login" class:wz-split={shot} style="--wz-top: var(--app-top, 0px)">
  <h2>Log in with Cloudflare</h2>
  <p>
    {#if hasPassword}
      A Cloudflare token proves this Worker is yours.
      <button type="button" class="link" onclick={() => ((useToken = false), (error = ''))}>Back to the password</button>
    {:else}
      The first time, a Cloudflare token proves this Worker is yours. After this you set a password for next time.
    {/if}
  </p>
  <Walk bind:shot>
    <WalkStep>
      Open the token page in Cloudflare.
      {#snippet controls()}<OpenButton href={TOKEN_TEMPLATE_URL} label="Open Cloudflare's token page" />{/snippet}
    </WalkStep>
    <WalkGuide ids={['cf-token']}>
      Click <b>Continue to summary</b>. Then click <b>Create Token</b>. Copy the token. Then you can close the Cloudflare tab. If your
      Cloudflare login has other accounts too, like an employer's, first change <b>All accounts</b> to your own account.
    </WalkGuide>
    <WalkStep>
      Paste the token here. It logs you in.
      {#snippet controls()}
        <form onsubmit={submit}>
          <input id="token" type="password" aria-label="The Cloudflare token" bind:value={token} oninput={tokenInput} placeholder="cfut_…" autocomplete="off" disabled={busy} />
          <button type="submit" disabled={busy || !token.trim()}>{busy ? 'Checking…' : 'Log in'}</button>
        </form>
      {/snippet}
    </WalkStep>
  </Walk>
  {#if error}<p class="err">{error}</p>{/if}
  <p class="muted">This browser stays logged in for a year.</p>
</section>
{/if}

<style>
  .login.wz-split {
    background: none;
    border: 0;
    border-radius: 0;
    margin: 0 0 0 auto;
    padding: 24px 20px 40px;
  }
</style>
