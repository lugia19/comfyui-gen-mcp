<script>
  import { onMount, untrack } from 'svelte'
  import { api, formatBytes } from './api.js'
  import LoraSection from './LoraSection.svelte'
  import Models from './Models.svelte'

  // The settings of one backend. *target*:
  //   machine  this computer (the Claude Desktop extension)
  //   pc       the Worker's paired PC: its own settings, saved on the Worker
  //   modal    the Worker's Modal generator
  //   url      the Worker's ComfyUI reached by URL
  // Each is independent: its packs, styles, LoRAs and keep-warm.
  let { info, refresh, target } = $props()
  // Read once: each page is remounted when its tab is opened (App's {#key}).
  const fixed = untrack(() => ({ target, info }))

  const MP = 1024 * 1024
  const TOOL_TITLES = {
    generate_illustrated_image: 'Illustrations and anime',
    generate_realistic_image: 'Realistic images',
    edit_image: 'Image editing',
  }

  // A working copy; saved as a whole.
  let cfg = $state($state.snapshot(fixed.target === 'pc' ? fixed.info.pc_config : fixed.info.config))
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

  const keepWarm = fixed.info.schema.find((f) => f.key === 'keep_warm_minutes')
  // Packs that take LoRAs, one entry per settings key: packs sharing a key share their LoRAs
  // (Anima and Anima Turbo).
  const loraPacks = Object.values(
    Object.groupBy(fixed.info.packs.flatMap((g) => g.packs).filter((p) => p.supports_loras), (p) => p.config_key),
  ).map((same) => ({ ...same[0], display_name: same.map((p) => p.display_name).join(' / ') }))
  // With a PC paired, Claude is told the PC's settings; the others only run what they are asked.
  const syncWarning = fixed.target !== 'pc' && fixed.target !== 'machine' && fixed.info.pc?.paired

  // LoRA files ({name: size}): a ComfyUI reached by URL has no listing.
  const filesPath = { machine: '/loras', pc: '/pc/loras', modal: '/loras' }[fixed.target]
  let loraFiles = $state(null)
  let loraError = $state('')

  async function loadLoras() {
    if (!filesPath) return
    try {
      loraFiles = (await api('GET', filesPath)).loras
      loraError = ''
    } catch (e) {
      loraFiles = {}
      loraError = e.message
    }
  }
  onMount(loadLoras)

  async function save() {
    saving = true
    message = ''
    error = ''
    try {
      const saved = await api('PUT', target === 'pc' ? '/pc/config' : '/config', { config: cfg })
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

{#if syncWarning}
  <section class="warn">
    <p>
      <b>Your PC is paired, so Claude's tools are described from Settings [Local]:</b> its styles, LoRA triggers and
      models. These settings are what Modal uses while the PC is off. Keep the styles, LoRAs and triggers here the same
      as the PC's by hand, or Modal will do something other than what Claude was told.
    </p>
  </section>
{/if}

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
    <LoraSection {cfg} packs={loraPacks} where={target} files={loraFiles} reload={loadLoras} error={loraError} />
  </section>
{/if}

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

{#if target === 'machine'}
  <section>{#key saves}<Models local />{/key}</section>
{:else if target === 'pc'}
  <section>{#key saves}<Models local path="/pc/models" title="Models on your PC" />{/key}</section>
{:else if target === 'modal'}
  <section>{#key saves}<Models />{/key}</section>
{/if}

<style>
  .warn { border-color: var(--err); }
</style>
