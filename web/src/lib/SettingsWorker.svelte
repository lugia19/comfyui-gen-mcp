<script>
  import { untrack } from 'svelte'
  import { api, imagesUrl } from './api.js'
  import ConnectorUrl from './ConnectorUrl.svelte'
  import SetPassword from './SetPassword.svelte'
  import { Task } from './task.svelte.js'

  // Settings → Worker: this Worker's own settings, each acting at once (not the page's Save).
  let { info, refresh } = $props()

  // New images stored encrypted in R2 (design §4).
  let encrypt = $state(untrack(() => Boolean(info.encrypt_images))) // then this page's own
  const saving = new Task()
  async function setEncrypt(on) {
    const ok = await saving.run(async () => {
      encrypt = (await api('POST', '/images/encryption', { on })).encrypt_images
      await refresh()
    })
    if (!ok) encrypt = !on
  }
  let images = $derived(imagesUrl(info))
</script>

<div class="cols">
  <section>
    <h2>Connector URL</h2>
    <p class="muted">Add it to claude.ai or any MCP client; scripts like Visual Novelist call it too.</p>
    <ConnectorUrl {info} {refresh} />
  </section>

  <section>
    <h2>Images in storage</h2>
    {#if info.storage}
      <label class="check">
        <input type="checkbox" checked={encrypt} disabled={saving.busy} onchange={(e) => setEncrypt(e.currentTarget.checked)} />
        Encrypt new images in R2
      </label>
      <p class="muted">
        New images are stored encrypted, so they aren't readable in your R2 bucket, by you or by automated scanning. The key
        stays in this Worker, so anyone who controls your Cloudflare account could still decrypt them. Images stored before
        are left as they are; turning this off keeps the encrypted ones readable here.
      </p>
      {#if saving.error}<p class="err">{saving.error}</p>{/if}
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
    <h2>Logging in</h2>
    {#if info.update_path === 'oauth'}
      <p class="muted">This page logs in with Cloudflare: whoever can sign in to the Cloudflare account this Worker is in. There is no password.</p>
    {:else}
      <p class="muted">The password for this page. Logging in with a Cloudflare token works too, and replaces the stored token.</p>
      <SetPassword />
    {/if}
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
</style>
