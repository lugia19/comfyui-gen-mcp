<script>
  import { onDestroy, onMount, untrack } from 'svelte'
  import { api } from './api.js'
  import Models from './Models.svelte'

  // The Claude Desktop extension's setup: install ComfyUI for this machine's GPU, see and control it,
  // and point it at other model folders or at a ComfyUI of your own.
  let { info, refresh } = $props()

  const GPU_LABELS = {
    nvidia: 'NVIDIA (CUDA)',
    amd: 'AMD (ROCm on Linux; CPU on Windows)',
    intel: 'Intel Arc',
    mac: 'Apple silicon',
    cpu: 'CPU only (very slow)',
  }
  const STATE_LABELS = {
    not_installed: 'Not installed',
    stopped: 'Installed, not running (it starts with the first image)',
    starting: 'Starting…',
    running: 'Running',
    failed: 'Failed to start',
    external: 'Using your own ComfyUI',
  }

  let comfy = $derived(info.comfyui)
  // The agent's page keeps the rarely needed parts (reinstalling, other model folders, a ComfyUI of
  // your own) folded under Advanced: its everyday settings live on the Worker's page.
  const agent = untrack(() => info.mode === 'agent')
  // The connector URL holds its secret: shown masked, as screenshots get shared.
  let showUrl = $state(false)
  let copied = $state(false)
  const masked = (u) => (u || '').replace(/(\/mcp\/).+$/, '$1••••••••')
  async function copyUrl() {
    await navigator.clipboard.writeText(info.connector_url)
    copied = true
    setTimeout(() => (copied = false), 1500)
  }
  let packCount = $state(0) // the agent has none of its own: its packs are the Worker's
  // Form fields start from the page's first state; later refreshes don't overwrite what is typed.
  let gpu = $state(untrack(() => info.comfyui.gpu || info.detected_gpu))
  let install = $state(untrack(() => info.install))
  let busy = $state('')
  let error = $state('')
  let timer = null

  let comfyUrl = $state(untrack(() => info.config.comfyui_url || ''))
  let extraDir = $state(untrack(() => info.config.extra_models_dir || ''))
  let saved = $state('')

  async function pollInstall() {
    install = await api('GET', '/setup/install')
    if (install.state === 'running') {
      timer = setTimeout(pollInstall, 1500)
    } else {
      await refresh()
    }
  }

  async function startInstall() {
    const again = comfy.state !== 'not_installed'
    if (again && !confirm('Reinstall ComfyUI? Models, outputs and settings are kept; custom nodes are reinstalled as needed.')) return
    error = ''
    try {
      install = await api('POST', '/setup/install', { gpu })
      pollInstall()
    } catch (e) {
      error = e.message
    }
  }

  async function action(name) {
    busy = name
    error = ''
    try {
      await api('POST', `/comfyui/${name}`)
    } catch (e) {
      error = e.message
    } finally {
      busy = ''
      await refresh()
    }
  }

  async function saveFolders(e) {
    e.preventDefault()
    error = ''
    saved = ''
    try {
      const r = await api('PUT', '/config', { config: { comfyui_url: comfyUrl.trim(), extra_models_dir: extraDir.trim() } })
      saved = ['Saved.', ...(r.warnings || [])].join(' ')
      await refresh()
    } catch (err) {
      error = err.message
    }
  }

  const open = (which) => api('POST', '/open', { which }).catch((e) => (error = e.message))

  onMount(() => install.state === 'running' && pollInstall())
  onDestroy(() => clearTimeout(timer))
</script>

<section>
  <h2>ComfyUI</h2>
  <p>
    <b class:ok={comfy.state === 'running' || comfy.state === 'external'} class:err={comfy.state === 'failed'}>
      {STATE_LABELS[comfy.state] || comfy.state}
    </b>
    {#if comfy.url && comfy.state !== 'stopped'}<span class="muted">at <code>{comfy.url}</code></span>{/if}
  </p>
  {#if comfy.dir}
    <p class="muted">
      In <code>{comfy.dir}</code>{#if comfy.version}, version {comfy.version}{/if}{#if comfy.gpu}, for {GPU_LABELS[comfy.gpu] || comfy.gpu}{/if}.
    </p>
  {/if}
  {#if comfy.error}<pre class="err">{comfy.error}</pre>{/if}
  {#if comfy.state !== 'not_installed' && comfy.state !== 'external'}
    <div class="row">
      <button class:secondary={comfy.state === 'running'} onclick={() => action('restart')} disabled={!!busy || install.state === 'running'}>
        {busy === 'restart' ? 'Restarting…' : comfy.state === 'running' ? 'Restart' : 'Start'}
      </button>
      {#if comfy.state === 'running'}
        <button class="secondary" onclick={() => action('stop')} disabled={!!busy}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</button>
      {/if}
    </div>
    <p class="muted">It stops by itself after the keep-warm time without images, to free the GPU.</p>
  {/if}
</section>

{#snippet installSection()}
  <section>
    <h2>{comfy.state === 'not_installed' ? 'Install ComfyUI' : 'Reinstall ComfyUI'}</h2>
    <p class="muted">
      Downloads ComfyUI and the PyTorch build for your GPU into <code>~/.comfy-gen-mcp</code>, a few GB.
      {#if info.detected_gpu}Detected: {GPU_LABELS[info.detected_gpu] || info.detected_gpu}.{/if}
    </p>
    {#each info.gpus as g (g)}
      <label class="choice">
        <input type="radio" name="gpu" value={g} bind:group={gpu} disabled={install.state === 'running'} />
        <span>{GPU_LABELS[g] || g}</span>
      </label>
    {/each}
    <button class:secondary={comfy.state !== 'not_installed'} onclick={startInstall} disabled={install.state === 'running'}>
      {install.state === 'running' ? 'Installing…' : comfy.state === 'not_installed' ? 'Install' : 'Reinstall'}
    </button>
    {#if install.state !== 'idle'}
      {#if install.state === 'done'}<p class="ok">Installed.</p>{/if}
      {#if install.error}<p class="err">{install.error}</p>{/if}
      <pre>{install.lines.slice(-14).join('\n')}</pre>
    {/if}
  </section>
{/snippet}

{#if comfy.state !== 'external' && !(agent && comfy.state !== 'not_installed' && install.state === 'idle')}
  {@render installSection()}
{/if}

{#if comfy.state !== 'not_installed' && comfy.state !== 'external'}
  <section hidden={!packCount}><Models local onchange={(p) => (packCount = p.length)} /></section>
{/if}

{#if comfy.state !== 'not_installed' && comfy.state !== 'external'}
  <section>
    <h2>Models found on this computer</h2>
    {#if info.model_sources.length}
      <p class="muted">ComfyUI uses these as they are; only what is in none of them is downloaded.</p>
      {#each info.model_sources as src, i (i)}
        <div class="source">
          <b>{src.from}</b>
          <code>{src.path}</code>
          <span class="muted">{src.folders.map((f) => f.type).join(', ')}</span>
        </div>
      {/each}
    {:else}
      <p class="muted">
        No other ComfyUI found. If you have one somewhere unusual, set its models folder below as
        "Another models folder".
      </p>
    {/if}
  </section>
{/if}

<section>
  <h2>Folders</h2>
  <div class="row">
    <button class="secondary" onclick={() => open('models')}>Models</button>
    {#if comfy.dir}<button class="secondary" onclick={() => open('output')}>Generated images</button>{/if}
    <button class="secondary" onclick={() => open('logs')}>Logs</button>
  </div>
  {#if agent}
    <details class="advanced">
      <summary>Advanced</summary>
      {#if comfy.state !== 'external' && comfy.state !== 'not_installed' && install.state === 'idle'}{@render installSection()}{/if}
      {@render folderForm()}
    </details>
  {:else}
    {@render folderForm()}
  {/if}
</section>

{#snippet folderForm()}
  <form onsubmit={saveFolders}>
    <label for="extra">Another models folder (optional)</label>
    <input id="extra" type="text" bind:value={extraDir} placeholder="D:\ComfyUI\models" />
    <p class="muted">
      The models folder of another ComfyUI install that isn't found by itself, used as is, so
      nothing is downloaded twice.
    </p>
    <label for="url">Your own ComfyUI (advanced)</label>
    <input id="url" type="text" bind:value={comfyUrl} placeholder="http://127.0.0.1:8188" />
    <p class="muted">
      Leave empty to use the managed one. A ComfyUI you run yourself is not started, stopped or given
      models; it needs the packs' models and nodes already.
    </p>
    <button type="submit">Save</button>
    {#if saved}<p class="ok">{saved}</p>{/if}
  </form>
{/snippet}

{#if info.mode !== 'agent'}
<section>
  <h2>Connect Claude</h2>
  <p>Claude Desktop connects through the extension by itself. Nothing to do here.</p>
  <p class="muted">
    Other MCP clients on this computer can use <code>{showUrl ? info.connector_url : masked(info.connector_url)}</code>
    <button type="button" class="link" onclick={() => (showUrl = !showUrl)}>{showUrl ? 'Hide' : 'Show'}</button>
    <button type="button" class="link" onclick={copyUrl}>{copied ? 'Copied' : 'Copy'}</button>. For claude.ai and your
    phone, use a Worker install instead.
  </p>
</section>
{/if}

{#if error}<p class="err">{error}</p>{/if}

<style>
  .source { margin: 8px 0; display: flex; flex-direction: column; gap: 2px; }
  .advanced { margin-top: 12px; }
  .advanced summary { cursor: pointer; color: var(--accent); }
  button.link { background: none; border: 0; padding: 0; margin: 0 0 0 6px; color: var(--accent); }
</style>
