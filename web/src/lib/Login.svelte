<script>
  import { api } from './api.js'

  let { onlogin } = $props()
  let password = $state('')
  let error = $state('')
  let busy = $state(false)

  async function submit(e) {
    e.preventDefault()
    busy = true
    error = ''
    try {
      await api('POST', '/login', { password })
      password = ''
      await onlogin()
    } catch (err) {
      error = err.message
    } finally {
      busy = false
    }
  }
</script>

<section>
  <h2>Log in</h2>
  <p class="muted">Use the setup password you chose when deploying.</p>
  <form onsubmit={submit}>
    <label for="password">Setup password</label>
    <input id="password" type="password" bind:value={password} autocomplete="current-password" />
    <button type="submit" disabled={busy || !password}>Log in</button>
    {#if error}<p class="err">{error}</p>{/if}
  </form>
</section>
