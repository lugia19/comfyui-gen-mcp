<script>
  import { onDestroy, onMount, untrack } from 'svelte'
  import { api, formatBytes } from './api.js'
  import LoraSection from './LoraSection.svelte'
  import Models from './Models.svelte'

  // The settings: the extension's, for this computer, or the Worker's, for every backend it has
  // (your PC, Modal or a ComfyUI URL). One config: Claude sees one set of tools. What differs per
  // backend is only which models and LoRA files it has, shown per backend below, and keep-warm.
  let { info, refresh } = $props()
  // Read once: the page is remounted each time its tab is opened.
  const fixed = untrack(() => ({ info }))
  const machine = fixed.info.mode === 'local'
  const pcPaired = !machine && Boolean(fixed.info.pc?.paired)
  const modal = !machine && fixed.info.generator?.kind === 'modal'

  const MP = 1024 * 1024
  const TOOL_TITLES = {
    generate_illustrated_image: 'Illustrations and anime',
    generate_realistic_image: 'Realistic images',
    edit_image: 'Image editing',
  }

  // A working copy; saved as a whole.
  let cfg = $state($state.snapshot(fixed.info.config))
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

  // Keep-warm per backend: the extension's own, Modal's (costs money while idle), the PC's.
  const keepWarms = fixed.info.schema
    .filter((f) => (f.key === 'keep_warm_minutes' ? machine || modal : f.pc ? pcPaired : false))
    .map((f) => (f.key === 'keep_warm_minutes' && pcPaired ? { ...f, title: 'Keep warm on Modal (minutes)' } : f))
  // Packs that take LoRAs, one entry per settings key: packs sharing a key share their LoRAs
  // (Anima and Anima Turbo).
  const loraPacks = Object.values(
    Object.groupBy(fixed.info.packs.flatMap((g) => g.packs).filter((p) => p.supports_loras), (p) => p.config_key),
  ).map((same) => ({ ...same[0], display_name: same.map((p) => p.display_name).join(' / ') }))
  // LoRA files on each backend. This computer's list is mapped to the Worker's shape.
  let loraListing = $state(null)

  // While the agent copies LoRAs, or for a while after an upload or a save (a copy may be about to
  // start), the list checks again every 3 s.
  let watchUntil = 0
  let loraTimer = null
  let alive = true
  onDestroy(() => {
    alive = false
    clearTimeout(loraTimer)
  })

  async function loadLoras(watch = false) {
    if (watch) watchUntil = Date.now() + 30_000
    clearTimeout(loraTimer)
    try {
      const got = await api('GET', '/loras')
      loraListing = machine
        ? { backends: ['machine'], files: Object.fromEntries(Object.entries(got.loras).map(([n, size]) => [n, { machine: size }])), syncing: {}, errors: {} }
        : got
    } catch (e) {
      loraListing = { backends: [], files: {}, syncing: {}, errors: { [machine ? 'machine' : 'the Worker']: e.message } }
    }
    const copying = Object.values(loraListing.syncing ?? {}).some((j) => !j.error)
    if (alive && (copying || Date.now() < watchUntil)) loraTimer = setTimeout(() => loadLoras(), 3000)
  }
  onMount(() => loadLoras())

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
      await loadLoras(true) // saving starts copies between the PC and Modal
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
  </section>
{/each}

{#if loraPacks.length}
  <section>
    <LoraSection {cfg} packs={loraPacks} listing={loraListing} reload={loadLoras} />
  </section>
{/if}

{#each keepWarms as f (f.key)}
  <section>
    <h2>{f.title}</h2>
    <p class="muted">{f.description}</p>
    <input type="number" min={f.min} max={f.max} bind:value={cfg[f.key]} />
  </section>
{/each}

<button onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
{#if message}<p class="ok">{message}</p>{/if}
{#each warnings as w}<p class="err">{w}</p>{/each}
{#if error}<p class="err">{error}</p>{/if}

{#if machine || pcPaired || modal}
  <section>{#key saves}<Models local={machine} />{/key}</section>
{/if}
