<script>
  import { api } from './api.js'
  import { Copy, masked } from './task.svelte.js'

  // This Worker's connector URL, to copy, show, or replace (Setup's last step and Settings → Worker).
  let { info, refresh } = $props()

  let showUrl = $state(false) // the URL holds its secret: masked, as screenshots get shared
  const urlCopy = new Copy()

  async function rotate() {
    if (!confirm('Make a new connector URL? The old one stops working, so you will need to add the new one in claude.ai.')) return
    await api('POST', '/setup/rotate-connector')
    await refresh()
  }
</script>

<div class="row"><code>{showUrl ? info.connector_url : masked(info.connector_url)}</code></div>
<div class="row">
  <button onclick={() => urlCopy.copy(info.connector_url)}>{urlCopy.done ? 'Copied' : 'Copy URL'}</button>
  <button class="secondary" onclick={() => (showUrl = !showUrl)}>{showUrl ? 'Hide' : 'Show'}</button>
</div>
<p class="muted">The URL works like a password: anyone with it can make images with your setup.
  <button type="button" class="link" onclick={rotate}>Make a new URL</button></p>
