<script>
  import { onDestroy, onMount } from 'svelte'
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
  let gpu = $state(info.comfyui.gpu || info.detected_gpu)
  let install = $state(info.install)
  let busy = $state('')
  let error = $state('')
  let timer = null

  let comfyUrl = $state(info.config.comfyui_url || '')
  let extraDir = $state(info.config.extra_models_dir || '')
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
      <button class="secondary" onclick={() => action('restart')} disabled={!!busy || install.state === 'running'}>
        {busy === 'restart' ? 'Restarting…' : comfy.state === 'running' ? 'Restart' : 'Start'}
      </button>
      {#if comfy.state === 'running'}
        <button class="secondary" onclick={() => action('stop')} disabled={!!busy}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</button>
      {/if}
    </div>
    <p class="muted">It stops by itself after the keep-warm time without images, to free the GPU.</p>
  {/if}
</section>

{#if comfy.state !== 'external'}
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
    <button onclick={startInstall} disabled={install.state === 'running'}>
      {install.state === 'running' ? 'Installing…' : comfy.state === 'not_installed' ? 'Install' : 'Reinstall'}
    </button>
    {#if install.state !== 'idle'}
      {#if install.state === 'done'}<p class="ok">Installed.</p>{/if}
      {#if install.error}<p class="err">{install.error}</p>{/if}
      <pre>{install.lines.slice(-14).join('\n')}</pre>
    {/if}
  </section>
{/if}

{#if comfy.state !== 'not_installed' && comfy.state !== 'external'}
  <section><Models local /></section>
{/if}

<section>
  <h2>Folders</h2>
  <div class="row">
    <button class="secondary" onclick={() => open('models')}>Models</button>
    <button class="secondary" onclick={() => open('loras')}>LoRAs</button>
    {#if comfy.dir}<button class="secondary" onclick={() => open('output')}>Generated images</button>{/if}
    <button class="secondary" onclick={() => open('logs')}>Logs</button>
  </div>
  <form onsubmit={saveFolders}>
    <label for="extra">Another models folder (optional)</label>
    <input id="extra" type="text" bind:value={extraDir} placeholder="D:\ComfyUI\models" />
    <p class="muted">
      A models folder of another ComfyUI, used as is, so nothing is downloaded twice. Installs that
      register themselves (Visual-Novelist, for one) are found without this.
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
</section>

<section>
  <h2>Connect Claude</h2>
  <p>Claude Desktop connects through the extension by itself. Nothing to do here.</p>
  <p class="muted">
    Other MCP clients on this computer can use <code>{info.connector_url}</code>. For claude.ai and your
    phone, use a Worker install instead.
  </p>
</section>

{#if error}<p class="err">{error}</p>{/if}
