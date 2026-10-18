<script>
  import { onMount } from 'svelte'
  import { api, TOKEN_TEMPLATE_URL } from './api.js'
  import { Task } from './task.svelte.js'
  import OpenButton from './OpenButton.svelte'
  import Walk from './Walk.svelte'
  import WalkGuide from './WalkGuide.svelte'
  import WalkStep from './WalkStep.svelte'

  // A Worker made by the setup site logs in with Cloudflare: the setup site's sign-in to the account
  // the Worker is in brings the browser back logged in (#ticket=…). One made from a repository logs
  // in with a Cloudflare token the first time, then sets a password for later logins. Either way a
  // pasted token is the way back in (the setup site down, the password forgotten).
  // *notice*: why a login link from the setup site didn't work.
  let { onlogin, notice = '' } = $props()
  let token = $state('')
  let password = $state('')
  let error = $state('')
  let busy = $state(false)
  let ways = $state(null) // GET /api/login: {cloudflare, password}; null while asking
  let hasPassword = $derived(Boolean(ways?.password))
  let useToken = $state(false)
  const cloudflare = new Task()
  const withCloudflare = () => cloudflare.run(async () => (location.href = (await api('POST', '/login/cloudflare')).url))
  let shot = $state(false) // the token walkthrough's screenshot shows: it takes the left of the window

  onMount(async () => {
    try {
      ways = await api('GET', '/login')
    } catch {
      ways = { cloudflare: false, password: false }
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
{#if ways === null}
  <p class="muted">Loading…</p>
{:else if ways.cloudflare && !useToken}
  <section>
    <h2>Log in</h2>
    <p>Cloudflare asks you to sign in and allow Comfy-Gen, then sends you back here, logged in. It proves this Worker is yours.</p>
    <button onclick={withCloudflare} disabled={cloudflare.busy}>{cloudflare.busy ? 'Opening Cloudflare…' : 'Log in with Cloudflare'}</button>
    {#if cloudflare.error}<p class="err">{cloudflare.error}</p>{/if}
    <p class="muted">
      Cloudflare unreachable from here? <button type="button" class="link" onclick={() => ((useToken = true), (error = ''))}>Log in with a Cloudflare token instead</button>.
    </p>
  </section>
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
    {#if ways.cloudflare || hasPassword}
      A Cloudflare token proves this Worker is yours.
      <button type="button" class="link" onclick={() => ((useToken = false), (error = ''))}>{ways.cloudflare ? 'Back to Log in with Cloudflare' : 'Back to the password'}</button>
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
