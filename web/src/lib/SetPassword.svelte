<script>
  import { api } from './api.js'

  // A password for this page: required once after the first (token) login, and changeable later.
  // *required* shows it as the step it is; *ondone* runs after it is saved.
  let { required = false, ondone } = $props()
  const MIN = 8
  let password = $state('')
  let again = $state('')
  let busy = $state(false)
  let error = $state('')
  let saved = $state(false)

  async function submit(e) {
    e.preventDefault()
    error = ''
    if (password !== again) return void (error = 'The two passwords differ.')
    busy = true
    try {
      await api('PUT', '/password', { password })
      password = again = ''
      saved = true
      await ondone?.()
    } catch (err) {
      error = err.message
    } finally {
      busy = false
    }
  }
</script>

<form onsubmit={submit}>
  {#if required}
    <h2>Set a password</h2>
    <p>
      Next time, log in with it instead of a Cloudflare token. If you ever forget it, a Cloudflare token still gets you
      in, and you can set a new one.
    </p>
  {/if}
  <label for="pw1">{required ? 'Password' : 'New password'}</label>
  <input id="pw1" type="password" bind:value={password} autocomplete="new-password" minlength={MIN} />
  <label for="pw2">Again</label>
  <input id="pw2" type="password" bind:value={again} autocomplete="new-password" minlength={MIN} />
  <p class="muted">At least {MIN} characters. A password manager's suggestion is ideal.</p>
  <button type="submit" disabled={busy || password.length < MIN || !again}>{busy ? 'Saving…' : 'Save password'}</button>
  {#if error}<p class="err">{error}</p>{/if}
  {#if saved && !required}<p class="ok">Saved. Use it the next time you log in.</p>{/if}
</form>
