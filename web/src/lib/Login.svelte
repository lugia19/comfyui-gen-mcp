<script>
  import { api, GUIDE, hideFigure, TOKEN_TEMPLATE_URL } from './api.js'

  let { onlogin } = $props()
  let token = $state('')
  let error = $state('')
  let busy = $state(false)

  async function submit(e) {
    e.preventDefault()
    busy = true
    error = ''
    try {
      await api('POST', '/login', { token: token.trim() })
      token = ''
      await onlogin()
    } catch (err) {
      error = err.message
    } finally {
      busy = false
    }
  }
</script>

<section>
  <h2>Log in with Cloudflare</h2>
  <p>
    There is no password: a Cloudflare API token that can manage this Worker proves it is yours. The
    Worker also keeps it to set up the GPU side and update itself.
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
  <p class="muted">This browser stays logged in for a year. Elsewhere, make a new token the same way.</p>
</section>

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
