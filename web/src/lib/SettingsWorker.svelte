<script>
  import { untrack } from 'svelte'
  import { api, imagesUrl } from './api.js'
  import SetPassword from './SetPassword.svelte'

  // Settings → Worker: this Worker's own settings, each acting at once (not the page's Save).
  let { info, refresh } = $props()

  // New images stored encrypted in R2 (design §4).
  let encrypt = $state(untrack(() => Boolean(info.encrypt_images))) // then this page's own
  let busy = $state(false)
  let error = $state('')
  async function setEncrypt(on) {
    busy = true
    error = ''
    try {
      encrypt = (await api('POST', '/images/encryption', { on })).encrypt_images
      await refresh()
    } catch (e) {
      encrypt = !on
      error = e.message
    } finally {
      busy = false
    }
  }
  let images = $derived(imagesUrl(info))
</script>

<div class="cols">
  <section>
    <h2>Images in storage</h2>
    {#if info.storage}
      <label class="check">
        <input type="checkbox" checked={encrypt} disabled={busy} onchange={(e) => setEncrypt(e.currentTarget.checked)} />
        Encrypt new images in R2
      </label>
      <p class="muted">
        New images are stored encrypted, so they aren't readable in your R2 bucket, by you or by automated scanning. The key
        stays in this Worker, so anyone who controls your Cloudflare account could still decrypt them. Images stored before
        are left as they are; turning this off keeps the encrypted ones readable here.
      </p>
      {#if error}<p class="err">{error}</p>{/if}
      {#if images}
        <p class="muted">
          <a href={images} target="_blank" rel="noopener">Your images on Cloudflare</a>: every image made, in the R2 bucket's
          <code>img/</code> folder. They expire after a year.
        </p>
      {/if}
    {:else}
      <p class="muted">Storage isn't turned on yet: the Setup tab has the step.</p>
    {/if}
  </section>

  <section>
    <h2>Password</h2>
    <p class="muted">The password for this page. Logging in with a Cloudflare token works too, and replaces the stored token.</p>
    <SetPassword />
    {#if info.cloudflare}
      <h3>This Worker</h3>
      <p class="muted">
        Worker <code>{info.cloudflare.script}</code> in Cloudflare account <code>{info.cloudflare.account_id}</code>.
      </p>
    {/if}
  </section>
</div>

<style>
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    max-width: 980px;
    gap: 16px;
    align-items: start;
  }
  .cols section {
    margin: 0;
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: center;
    font-weight: normal;
  }
  .check input {
    width: auto;
    margin: 0;
  }
</style>
