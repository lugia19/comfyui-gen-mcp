<script>
  import { formatBytes } from './api.js'
  import ModelState from './ModelState.svelte'

  // Settings → Models: one card per image tool, side by side. A card picks the tool's model and its
  // options (saved with the page's Save), and its foot shows that model's download on each GPU
  // (*status*, a ModelStatus), which starts at once. A tool whose group says `within` (the reference
  // tool) has its choice inside that tool's card. *cfg* is the page's working copy, *saved* the last
  // saved config, *packs* /api/state's tool groups. *marks* and *redraw*: the remove_marks and
  // show_redraw settings' schema entries, small checkboxes at the foot of the illustrations card
  // (signatures come with artist styles; redraw repaints illustrations).
  let { cfg = $bindable(), saved, packs, status, marks = null, redraw = null } = $props()

  const ILLUSTRATED = 'generate_illustrated_image' // core REDRAW_TOOL
  const cards = $derived(packs.filter((g) => !g.within))
  const inside = (group) => packs.filter((g) => g.within === group.tool_name)

  const MP = 1024 * 1024

  function selected(group, config) {
    const wanted = config.pack_selections[group.tool_name]
    return group.packs.find((p) => p.name === wanted) || group.packs.find((p) => p.is_default) || group.packs[0]
  }

  // The tool's default first, then its other current models, the bigger (better) ones first, then the
  // older (legacy) ones, which stay selectable.
  const rank = (p) => (p.is_default ? 0 : p.legacy ? 2 : 1)
  const ordered = (group) => [...group.packs].sort((a, b) => rank(a) - rank(b) || (a.legacy ? 0 : b.download_size - a.download_size))

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

<!-- A choice inside another tool's card (the reference models) shows no size: it adds only a small
     file to that tool's models. -->
{#snippet choices(group)}
  {@const current = selected(group, cfg)}
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
          {#if !group.within}<span class="muted">{formatBytes(pack.download_size)}</span>{/if}<br />
          <span class="muted">{pack.description}</span>
        </span>
      </label>
    {/each}
  {:else}
    <p><b>{current.display_name}</b> {#if !group.within}<span class="muted">{formatBytes(current.download_size)}</span>{/if}</p>
    <p class="muted">{current.description}</p>
  {/if}
{/snippet}

{#snippet downloads(group)}
  {@const current = selected(group, cfg)}
  {@const unsaved = current.name !== selected(group, saved).name}
  {@const row = unsaved ? null : status.of(current.name)}
  {#if unsaved || (row && status.backends.length)}
    <div class="foot">
      {#if unsaved}
        <p class="muted">Not saved yet. Saving downloads {current.display_name}{group.within ? '' : ` (${formatBytes(current.download_size)})`} to any GPU that lacks it.</p>
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
{/snippet}

<div class="cards">
  {#each cards as group (group.tool_name)}
    {@const current = selected(group, cfg)}
    <section class="card">
      <h2>{group.title || group.tool_name}</h2>
      {@render choices(group)}

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

      {@render downloads(group)}

      {#each inside(group) as sub (sub.tool_name)}
        <div class="sub">
          <h3>{sub.title || sub.tool_name}</h3>
          {@render choices(sub)}
          {@render downloads(sub)}
        </div>
      {/each}

      {#if group.tool_name === ILLUSTRATED && (marks || redraw)}
        <div class="options">
          {#if marks}
            <label class="small" title={marks.description}><input type="checkbox" bind:checked={cfg.remove_marks} /> {marks.title}</label>
          {/if}
          {#if redraw}
            <label class="small" title={redraw.description}><input type="checkbox" bind:checked={cfg.show_redraw} /> {redraw.title}</label>
          {/if}
        </div>
      {/if}
    </section>
  {/each}
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
  .sub {
    border-top: 1px solid var(--border);
    margin-top: 14px;
    padding-top: 4px;
  }
  .sub h3 {
    margin: 8px 0 4px;
  }
  .options {
    border-top: 1px solid var(--border);
    margin-top: 14px;
    padding-top: 8px;
  }
  .small {
    display: block;
    font-size: 13px;
    color: var(--muted);
    margin: 4px 0;
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
