<script>
  import { api, TOKEN_TEMPLATE_URL } from './api.js'

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
