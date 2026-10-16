<script>
  import { onDestroy, onMount, untrack } from 'svelte'
  import { api, pcPage } from './api.js'
  import Models from './Models.svelte'
  import { Copy, masked, Task } from './task.svelte.js'

  // The Claude Desktop extension's setup: install ComfyUI for this machine's GPU, see and control it,
  // and point it at other model folders. The agent's page too, here or as
  // the PC's page on the Worker (*remote*: api.js relays the calls), where only opening a folder on
  // the PC's screen isn't offered.
  let { info, refresh } = $props()
  const remote = pcPage !== null

  const GPU_LABELS = {
    nvidia: 'NVIDIA',
    amd: 'AMD (fast on Linux; very slow on Windows)',
    intel: 'Intel Arc',
    mac: 'Mac with Apple silicon',
    cpu: 'No graphics card (very slow)',
  }
  const STATE_LABELS = {
    not_installed: 'Not installed',
    stopped: 'Installed, not running (it starts with the first image)',
    starting: 'Starting…',
    stopping: 'Stopping…',
    running: 'Running',
    failed: 'Failed to start',
    external: 'Using your own ComfyUI', // an agent from before v1.16.0, seen from the Worker's page
  }

  let comfy = $derived(info.comfyui)
  // A Mac's GPU shares its memory: below 16 GB, images swap and take tens of minutes (macOS test, 2026-10-02).
  let lowMemory = $derived((comfy.gpu || info.detected_gpu) === 'mac' && info.memory_gb > 0 && info.memory_gb < 16)
  // The folder example in the machine's style: the PC's (an agent says which), else the browser's.
  const platform = untrack(() => info.platform) ?? (/Mac/.test(navigator.userAgent) ? 'darwin' : /Linux/.test(navigator.userAgent) ? 'linux' : 'win32')
  const examplePath = platform === 'darwin' ? '/Users/you/ComfyUI/models' : platform === 'linux' ? '/home/you/ComfyUI/models' : 'D:\\ComfyUI\\models'
  // The agent's page keeps the rarely needed parts (reinstalling, other model folders, a ComfyUI of
  // your own) folded under Advanced: its everyday settings live on the Worker's page.
  const agent = untrack(() => info.mode === 'agent')
  // The connector URL holds its secret: shown masked, as screenshots get shared.
  let showUrl = $state(false)
  const urlCopy = new Copy()
  let packCount = $state(0) // the agent has none of its own: its packs are the Worker's
  // Form fields start from the page's first state; later refreshes don't overwrite what is typed.
  let gpu = $state(untrack(() => info.comfyui.gpu || info.detected_gpu))
  let install = $state(untrack(() => info.install))
  const task = new Task() // busy: 'restart' or 'stop' while ComfyUI starts or stops
  const installTask = new Task() // its error shows by the Install button (a bad models folder)
  let acting = $derived(task.busy === 'restart' || task.busy === 'stop')
  // A start or stop call returns only once it is done, so while one runs the label says so.
  let shown = $derived(task.busy === 'restart' ? 'starting' : task.busy === 'stop' ? 'stopping' : comfy.state)
  let timer = null

  let network = $state(untrack(() => info.config.mcp_network === true))
  const saveNetwork = (on) => task.run(async () => (await api('PUT', '/config', { config: { mcp_network: on } }), (network = on)))

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
    const started = await installTask.run(async () => {
      // A first install takes the models folder typed above it first: a bad one stops it here.
      if (!again && extraDir.trim() !== (info.config.extra_models_dir || '')) {
        await api('PUT', '/config', { config: { extra_models_dir: extraDir.trim() } })
      }
      install = await api('POST', '/setup/install', { gpu })
    })
    if (started) pollInstall()
  }

  async function action(name) {
    await task.run(() => api('POST', `/comfyui/${name}`), name)
    await refresh()
  }

  function saveFolders(e) {
    e.preventDefault()
    saved = ''
    task.run(async () => {
      const r = await api('PUT', '/config', { config: { extra_models_dir: extraDir.trim() } })
      saved = ['Saved.', ...(r.warnings || [])].join(' ')
      await refresh()
    })
  }

  const open = (which) => task.run(() => api('POST', '/open', { which }))

  onMount(() => install.state === 'running' && pollInstall())
  onDestroy(() => clearTimeout(timer))
</script>

<section>
  <h2>ComfyUI</h2>
  <p>
    <b class:ok={shown === 'running' || shown === 'external'} class:err={shown === 'failed'}>
      {STATE_LABELS[shown] || shown}
    </b>
    {#if comfy.url && shown !== 'stopped' && !acting}<span class="muted">at <code>{comfy.url}</code></span>{/if}
  </p>
  {#if comfy.dir}
    <p class="muted">
      In <code>{comfy.dir}</code>{#if comfy.version}, version {comfy.version}{/if}{#if comfy.gpu}, for {GPU_LABELS[comfy.gpu] || comfy.gpu}{/if}.
    </p>
  {/if}
  {#if comfy.error}<pre class="err">{comfy.error}</pre>{/if}
  {#if lowMemory}
    <p class="warn">
      This Mac has {info.memory_gb} GB of memory, which its GPU shares. Image models need about 6 to 16 GB on
      top of macOS, so an image here takes 10 to 50 minutes (measured on 8 GB). 16 GB is the practical
      minimum; 24 GB or more is recommended. Modal or another PC will be much faster.
    </p>
  {/if}
  {#if comfy.state !== 'not_installed'}
    <div class="row">
      <button class:secondary={comfy.state === 'running'} onclick={() => action('restart')} disabled={acting || install.state === 'running'}>
        {comfy.state === 'running' ? (task.busy === 'restart' ? 'Restarting…' : 'Restart') : task.busy === 'restart' ? 'Starting…' : 'Start'}
      </button>
      {#if comfy.state === 'running'}
        <button class="secondary" onclick={() => action('stop')} disabled={acting}>{task.busy === 'stop' ? 'Stopping…' : 'Stop'}</button>
      {/if}
    </div>
    <p class="muted">When it makes no images for the keep-warm time, it stops by itself. This frees the GPU.</p>
  {/if}
</section>

{#snippet installSection()}
  <section>
    <h2>{comfy.state === 'not_installed' ? 'Install ComfyUI' : 'Reinstall ComfyUI'}</h2>
    <p>
      ComfyUI is the program that makes the images. It needs a few GB.
      {#if info.detected_gpu}This {remote ? 'PC' : 'computer'} has: <b>{GPU_LABELS[info.detected_gpu] || info.detected_gpu}</b>.{/if}
    </p>
    {#each info.gpus as g (g)}
      <label class="choice">
        <input type="radio" name="gpu" value={g} bind:group={gpu} disabled={install.state === 'running'} />
        <span>{GPU_LABELS[g] || g}</span>
      </label>
    {/each}
    {#if comfy.state === 'not_installed'}
      <!-- Before anything downloads: models already here are used as they are, never downloaded twice. -->
      <h3>Models you already have</h3>
      {#if info.model_sources.length}
        <p class="muted">Found on this {remote ? 'PC' : 'computer'}, used as they are:</p>
        {#each info.model_sources as src, i (i)}
          <div class="source"><b>{src.from}</b> <code>{src.path}</code></div>
        {/each}
      {:else}
        <p class="muted">No other ComfyUI found on this {remote ? 'PC' : 'computer'}.</p>
      {/if}
      <label for="extra-first">Another models folder (optional)</label>
      <input id="extra-first" type="text" bind:value={extraDir} placeholder={examplePath} disabled={install.state === 'running'} />
      <p class="muted">Do you keep models in another folder, for example another ComfyUI that is not listed above? Type that models folder here. Then nothing is downloaded twice.</p>
    {/if}
    <button class:secondary={comfy.state !== 'not_installed'} onclick={startInstall} disabled={install.state === 'running' || installTask.busy}>
      {install.state === 'running' ? 'Installing…' : comfy.state === 'not_installed' ? 'Install ComfyUI' : 'Reinstall'}
    </button>
    {#if installTask.error}<p class="err">{installTask.error}</p>{/if}
    {#if install.state !== 'idle'}
      {#if install.state === 'done'}<p class="ok">Installed.</p>{/if}
      {#if install.error}<p class="err">{install.error}</p>{/if}
      <pre>{install.lines.slice(-14).join('\n')}</pre>
    {/if}
  </section>
{/snippet}

{#if !(agent && comfy.state !== 'not_installed' && install.state === 'idle')}
  {@render installSection()}
{/if}

{#if comfy.state !== 'not_installed'}
  <section hidden={!packCount}><Models local onchange={(p) => (packCount = p.length)} /></section>
{/if}

{#if comfy.state !== 'not_installed'}
  <section>
    <h2>Models found on this {remote ? 'PC' : 'computer'}</h2>
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
        No other ComfyUI found. If you have one somewhere unusual, set its models folder as
        "Another models folder" below.
      </p>
    {/if}
  </section>
{/if}

<section>
  <h2>Folders</h2>
  {#if !remote}
    <div class="row">
      <button class="secondary" onclick={() => open('models')}>Models</button>
      {#if comfy.dir}<button class="secondary" onclick={() => open('output')}>Generated images</button>{/if}
      <button class="secondary" onclick={() => open('logs')}>Logs</button>
    </div>
  {/if}
  {#if agent && remote}
    <!-- The PC's page on the Worker: no folders to open here, so its folder settings show at once. -->
    {@render folderForm()}
    {#if comfy.state !== 'not_installed' && install.state === 'idle'}
      <details class="advanced">
        <summary>Advanced</summary>
        {@render installSection()}
      </details>
    {/if}
  {:else if agent}
    <details class="advanced">
      <summary>Advanced</summary>
      {#if comfy.state !== 'not_installed' && install.state === 'idle'}{@render installSection()}{/if}
      {@render folderForm()}
    </details>
  {:else}
    {@render folderForm()}
  {/if}
</section>

{#snippet extraField()}
  <label for="extra">Another models folder (optional)</label>
  <input id="extra" type="text" bind:value={extraDir} placeholder={examplePath} />
  <p class="muted">
    The models folder of another ComfyUI install that isn't found by itself, used as is, so
    nothing is downloaded twice.
  </p>
{/snippet}

<!-- The models folder, once installed (before the install it is asked in the install section). -->
{#snippet folderForm()}
  {#if comfy.state !== 'not_installed'}
    <form onsubmit={saveFolders}>
      {@render extraField()}
      <button type="submit">Save</button>
      {#if saved}<p class="ok">{saved}</p>{/if}
    </form>
  {/if}
{/snippet}

{#if info.mode !== 'agent'}
<section>
  <h2>Connect Claude</h2>
  <p>Claude Desktop connects through the extension by itself. Nothing to do here.</p>
  <p>
    <b>Don't also run the Comfy-Gen agent on this computer:</b> two don't fit on one graphics card. Use this
    extension, or the agent with a Worker (which Claude Desktop can use too).
  </p>
  <p class="muted">
    Other MCP clients on this computer can use <code>{showUrl ? info.connector_url : masked(info.connector_url)}</code>
    <button type="button" class="link" onclick={() => (showUrl = !showUrl)}>{showUrl ? 'Hide' : 'Show'}</button>
    <button type="button" class="link" onclick={() => urlCopy.copy(info.connector_url)}>{urlCopy.done ? 'Copied' : 'Copy'}</button>. For claude.ai and your
    phone, use a Worker install instead.
  </p>
  <details class="advanced">
    <summary>Advanced</summary>
    <label class="check">
      <input type="checkbox" checked={network} onchange={(e) => saveNetwork(e.currentTarget.checked)} />
      Let other computers on the network use it
    </label>
    <p class="muted">
      Off, only this computer can reach the extension. On, a client on another computer (such as
      LibreChat) can use the address above with this computer's network address instead of
      127.0.0.1; the address's secret part is all that guards it, so leave this off on public
      networks. The settings page always answers only on this computer.
      {#if network !== info.listening_on_network}<b>Restart Claude Desktop for the change to take effect.</b>{/if}
    </p>
  </details>
</section>
{/if}

{#if task.error}<p class="err">{task.error}</p>{/if}

<style>
  .source { margin: 8px 0; display: flex; flex-direction: column; gap: 2px; }
  .advanced { margin-top: 12px; }
  .advanced summary { cursor: pointer; color: var(--accent); }
  .warn { border-left: 3px solid var(--err); padding-left: 10px; }
  button.link { background: none; border: 0; padding: 0; margin: 0 0 0 6px; color: var(--accent); }
</style>
