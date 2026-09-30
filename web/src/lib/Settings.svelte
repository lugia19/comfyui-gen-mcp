<script>
  import { onMount } from 'svelte'
  import { api, formatBytes } from './api.js'
  import Loras from './Loras.svelte'
  import Models from './Models.svelte'

  let { info, refresh } = $props()

  const MP = 1024 * 1024
  const TOOL_TITLES = {
    generate_illustrated_image: 'Illustrations and anime',
    generate_realistic_image: 'Realistic images',
    edit_image: 'Image editing',
  }

  // A working copy; saved as a whole.
  let cfg = $state($state.snapshot(info.config))
  let saving = $state(false)
  let message = $state('')
  let error = $state('')
  let warnings = $state([])
  let saves = $state(0) // remounts the model list after a save, which may start downloads

  function selectedPack(group) {
    const wanted = cfg.pack_selections[group.tool_name]
    return group.packs.find((p) => p.name === wanted) || group.packs.find((p) => p.is_default) || group.packs[0]
  }

  function packSettings(pack) {
    cfg.pack_settings[pack.config_key] ??= {}
    return cfg.pack_settings[pack.config_key]
  }

  function megapixels(pack) {
    const px = cfg.pack_settings[pack.config_key]?.max_pixels ?? pack.max_pixels
    return Math.round((px / MP) * 100) / 100
  }

  function setMegapixels(pack, value) {
    const mp = Math.min(Math.max(Number(value) || 0.5, 0.5), pack.max_pixels_limit / MP)
    packSettings(pack).max_pixels = Math.round(mp * MP)
  }

  const keepWarm = info.schema.find((f) => f.key === 'keep_warm_minutes')

  // LoRA files ({name: size}) for the rows' file picker: on the Modal Volume, or locally in the
  // LoRA folders ComfyUI reads. A ComfyUI the Worker reaches by URL has its own, so there the name is
  // typed.
  const local = info.mode === 'local'
  const onModal = info.generator?.kind === 'modal'
  // A paired PC generates when it is online: its LoRA files come first.
  const onPc = Boolean(info.pc?.paired)
  const pickLoras = onModal || local || onPc
  let loraFiles = $state(null)
  let loraError = $state('')

  async function loadLoras() {
    try {
      loraFiles = (await api('GET', onPc ? '/pc/loras' : '/loras')).loras
      loraError = ''
    } catch (e) {
      loraFiles = {}
      loraError = e.message
    }
  }

  // With a PC and Modal both, the picker shows the PC's files; Modal's upload list keeps its own.
  let modalLoras = $state(null)
  async function loadModalLoras() {
    try {
      modalLoras = (await api('GET', '/loras')).loras
    } catch (e) {
      modalLoras = {}
      loraError = e.message
    }
  }

  onMount(() => {
    if (pickLoras) loadLoras()
    if (onPc && onModal) loadModalLoras()
  })

  const stem = (name) => (name || '').replace(/\.safetensors$/i, '')

  // For rendering (no writes during render); loraRows creates the list for the handlers.
  const rowsOf = (pack) => cfg.pack_loras[pack.config_key] ?? []

  function loraRows(pack) {
    cfg.pack_loras[pack.config_key] ??= []
    return cfg.pack_loras[pack.config_key]
  }

  function addLora(pack) {
    const name = pickLoras ? Object.keys(loraFiles || {})[0] || '' : ''
    loraRows(pack).push({ name, strength: 1, trigger: stem(name), hidden: false })
  }

  function setLoraName(row, name) {
    // A trigger still at its default follows the file.
    if (!row.trigger || row.trigger === stem(row.name)) row.trigger = stem(name)
    row.name = name
  }

  async function save() {
    saving = true
    message = ''
    error = ''
    try {
      const saved = await api('PUT', '/config', { config: cfg })
      cfg = saved.config
      warnings = saved.warnings || []
      saves += 1
      message = 'Saved. New chats pick up tool changes; existing chats keep the tools they started with.'
      await refresh()
    } catch (e) {
      error = e.message
    } finally {
      saving = false
    }
  }
</script>

{#each info.packs as group (group.tool_name)}
  {@const current = selectedPack(group)}
  <section>
    <h2>{TOOL_TITLES[group.tool_name] || group.tool_name}</h2>
    {#if group.packs.length > 1}
      {#each group.packs as pack (pack.name)}
        <label class="choice">
          <input
            type="radio"
            name={group.tool_name}
            value={pack.name}
            checked={pack.name === current.name}
            onchange={() => (cfg.pack_selections[group.tool_name] = pack.name)}
          />
          <span>
            <b>{pack.display_name}</b>
            <span class="muted">{formatBytes(pack.download_size)}</span><br />
            <span class="muted">{pack.description}</span>
          </span>
        </label>
      {/each}
    {:else}
      <p><b>{current.display_name}</b> <span class="muted">{formatBytes(current.download_size)}</span></p>
      <p class="muted">{current.description}</p>
    {/if}

    {#if current.max_pixels_limit}
      <label for="mp-{group.tool_name}">Maximum resolution (megapixels)</label>
      <input
        id="mp-{group.tool_name}"
        type="number"
        min="0.5"
        step="0.25"
        max={current.max_pixels_limit / MP}
        value={megapixels(current)}
        onchange={(e) => setMegapixels(current, e.currentTarget.value)}
      />
      <p class="muted">Up to {current.max_pixels_limit / MP} MP. Higher is slower.</p>
    {/if}

    {#if current.default_artist_list}
      <label for="artists-{group.tool_name}">Artist styles</label>
      <input
        id="artists-{group.tool_name}"
        type="text"
        value={cfg.pack_settings[current.config_key]?.artist_list ?? ''}
        placeholder={current.default_artist_list}
        oninput={(e) => (packSettings(current).artist_list = e.currentTarget.value)}
      />
      <p class="muted">
        Comma-separated; the first is the default. Browse styles in the
        <a href="https://thetacursed.github.io/Anima-Style-Explorer/index.html" target="_blank" rel="noopener">Anima Style Explorer</a>.
      </p>
    {/if}

    {#if current.supports_loras}
      <h3>LoRAs</h3>
      <p class="muted">
        A LoRA with a trigger applies only when the prompt contains that word; without one it always applies.
        Claude is told the triggers unless the LoRA is hidden.
      </p>
      {#each rowsOf(current) as row, i (i)}
        <div class="row lora">
          {#if pickLoras}
            <select value={row.name} onchange={(e) => setLoraName(row, e.currentTarget.value)} aria-label="LoRA file">
              {#if row.name && loraFiles && !(row.name in loraFiles)}
                <option value={row.name}>{row.name} ({local ? 'not found' : 'not uploaded'})</option>
              {/if}
              {#each Object.keys(loraFiles || {}) as name (name)}<option value={name}>{name}</option>{/each}
            </select>
          {:else}
            <input type="text" value={row.name} placeholder="file.safetensors" aria-label="LoRA file"
              onchange={(e) => setLoraName(row, e.currentTarget.value.trim())} />
          {/if}
          <input class="strength" type="number" min="-5" max="5" step="0.1" bind:value={row.strength} aria-label="Strength" title="Strength" />
          <input class="trigger" type="text" bind:value={row.trigger} placeholder="always on" aria-label="Trigger" title="Trigger word" />
          <label class="hidden"><input type="checkbox" bind:checked={row.hidden} /> Hidden</label>
          <button class="secondary" onclick={() => loraRows(current).splice(i, 1)}>Remove</button>
        </div>
      {/each}
      <button class="secondary" onclick={() => addLora(current)} disabled={pickLoras && !Object.keys(loraFiles || {}).length}>Add LoRA</button>
      {#if pickLoras && loraFiles && !Object.keys(loraFiles).length}
        <p class="muted">{local ? 'Put a LoRA file in the LoRAs folder (below) first.' : 'Upload a LoRA file below first.'}</p>
      {/if}
    {/if}
  </section>
{/each}

{#if keepWarm}
  <section>
    <h2>{keepWarm.title}</h2>
    <p class="muted">{keepWarm.description}</p>
    <input type="number" min={keepWarm.min} max={keepWarm.max} bind:value={cfg.keep_warm_minutes} />
  </section>
{/if}

<button onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
{#if message}<p class="ok">{message}</p>{/if}
{#each warnings as w}<p class="err">{w}</p>{/each}
{#if error}<p class="err">{error}</p>{/if}

{#if local}
  <section>
    <h2>LoRA files</h2>
    <p class="muted">.safetensors files in ComfyUI's LoRAs folder, or in a shared models folder.</p>
    {#each Object.entries(loraFiles || {}) as [name, size] (name)}
      <div class="row"><span>{name}</span><span class="muted">{formatBytes(size)}</span></div>
    {/each}
    <div class="row">
      <button class="secondary" onclick={() => api('POST', '/open', { which: 'loras' })}>Open LoRAs folder</button>
      <button class="secondary" onclick={loadLoras}>Refresh</button>
    </div>
    {#if loraError}<p class="err">{loraError}</p>{/if}
  </section>
  <section>
    {#key saves}<Models local />{/key}
  </section>
{:else if onPc}
  <section>
    <h2>LoRA files</h2>
    <p class="muted">The .safetensors files in your PC's LoRA folders (open them from the agent's tray icon).</p>
    {#each Object.entries(loraFiles || {}) as [name, size] (name)}
      <div class="row"><span>{name}</span><span class="muted">{formatBytes(size)}</span></div>
    {/each}
    <button class="secondary" onclick={loadLoras}>Refresh</button>
    {#if loraError}<p class="err">{loraError}</p>{/if}
  </section>
  <section>
    {#key saves}<Models local path="/pc/models" title="Models on your PC" />{/key}
  </section>
{/if}
{#if onModal && !local}
  <section>
    <Loras files={onPc ? modalLoras : loraFiles} reload={onPc ? loadModalLoras : loadLoras} />
    {#if loraError}<p class="err">{loraError}</p>{/if}
  </section>
  <section>
    {#key saves}<Models />{/key}
  </section>
{/if}

<style>
  h3 { font-size: 15px; margin: 16px 0 4px; }
  .lora { margin: 6px 0; flex-wrap: nowrap; }
  .lora select { flex: 1; min-width: 0; padding: 7px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font: inherit; }
  .lora .strength { width: 72px; }
  .lora .trigger { width: 130px; }
  .lora .hidden { display: flex; gap: 4px; align-items: center; margin: 0; font-weight: normal; white-space: nowrap; }
  .lora button { margin-top: 0; }
  @media (max-width: 560px) { .lora { flex-wrap: wrap; } }
</style>
