<script>
  import { formatBytes } from './api.js'
  import ModelState from './ModelState.svelte'

  // Settings → Models: one card per image tool, side by side. A card picks the tool's model and its
  // options (saved with the page's Save), and its foot shows that model's download on each GPU
  // (*status*, a ModelStatus), which starts at once. *cfg* is the page's working copy, *saved* the
  // last saved config, *packs* /api/state's tool groups. *marks*: the remove_marks setting's schema
  // entry, a card of its own (its models download in the background, never shown).
  let { cfg = $bindable(), saved, packs, status, marks = null } = $props()

  const MP = 1024 * 1024

  function selected(group, config) {
    const wanted = config.pack_selections[group.tool_name]
    return group.packs.find((p) => p.name === wanted) || group.packs.find((p) => p.is_default) || group.packs[0]
  }

  // Older models (legacy) stay selectable, listed after the current ones.
  const ordered = (group) => [...group.packs.filter((p) => !p.legacy), ...group.packs.filter((p) => p.legacy)]

  function packSettings(pack) {
    cfg.pack_settings[pack.family] ??= {}
    return cfg.pack_settings[pack.family]
  }

  function megapixels(pack) {
    const px = cfg.pack_settings[pack.family]?.max_pixels ?? pack.max_pixels
    return Math.round((px / MP) * 100) / 100
  }

  function setMegapixels(pack, value) {
    const mp = Math.min(Math.max(Number(value) || 0.5, 0.5), pack.max_pixels_limit / MP)
    packSettings(pack).max_pixels = Math.round(mp * MP)
  }
</script>

<div class="cards">
  {#each packs as group (group.tool_name)}
    {@const current = selected(group, cfg)}
    {@const unsaved = current.name !== selected(group, saved).name}
    {@const row = unsaved ? null : status.of(current.name)}
    <section class="card">
      <h2>{group.title || group.tool_name}</h2>
      {#if group.packs.length > 1}
        {#each ordered(group) as pack (pack.name)}
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
              {#if pack.legacy}<span class="muted">(older)</span>{/if}
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
          value={cfg.pack_settings[current.family]?.artist_list ?? ''}
          placeholder={current.default_artist_list}
          oninput={(e) => (packSettings(current).artist_list = e.currentTarget.value)}
        />
        <p class="muted">
          Comma-separated; the first is the default. Browse styles in the
          <a href="https://thetacursed.github.io/Anima-Style-Explorer/index.html" target="_blank" rel="noopener">Anima Style Explorer</a>.
        </p>
      {/if}

      {#if current.lora_group}
        {@const on = (cfg.pack_loras[current.lora_group] ?? []).filter((e) => e.enabled).length}
        <p class="muted loras">
          LoRAs: {on ? `${on} on` : 'none on'} ·
          <a href="#settings/loras/{current.lora_group}">{on ? 'Manage' : 'Add'} LoRAs</a>
        </p>
      {/if}

      {#if unsaved || (row && status.backends.length)}
      <div class="foot">
        {#if unsaved}
          <p class="muted">Not saved yet. Saving downloads {current.display_name} ({formatBytes(current.download_size)}) to any GPU that lacks it.</p>
        {:else if row}
          {#each status.backends as where (where)}
            {@const s = row.on[where] ?? { state: 'unknown' }}
            <div class="place">
              <span class="where">{status.names[where] ?? 'This computer'}</span>
              <ModelState {s} {status} pack={current.name} {where} />
            </div>
            {#if s.state === 'downloading' && s.total}<progress max={s.total} value={s.done}></progress>{/if}
            {#if s.error}<p class="err">{s.error}</p>{/if}
          {/each}
        {/if}
      </div>
      {/if}
    </section>
  {/each}
  {#if marks}
    <section class="card">
      <h2>Watermark removal</h2>
      <label class="choice">
        <input type="checkbox" bind:checked={cfg.remove_marks} />
        <span><b>{marks.title}</b><br /><span class="muted">{marks.description}</span></span>
      </label>
    </section>
  {/if}
</div>
{#if status.error}<p class="err">{status.error}</p>{/if}
<p class="muted">Models download once to each GPU (a PC's ComfyUI models folder, or your Modal Volume). A tool whose model is still downloading says so.</p>

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
    align-items: start;
  }
  .card {
    margin: 0;
    display: flex;
    flex-direction: column;
  }
  .card h2 {
    margin-top: 4px;
  }
  .loras {
    margin: 10px 0 0;
  }
  .foot {
    border-top: 1px solid var(--border);
    margin-top: 14px;
    padding-top: 8px;
  }
  .place {
    display: flex;
    align-items: center;
    gap: 6px 12px;
    flex-wrap: wrap;
    margin: 4px 0;
  }
  .where {
    font-weight: 600;
    min-width: 90px;
  }
  .place :global(button) {
    margin-left: auto;
  }
  progress {
    width: 100%;
  }
</style>
