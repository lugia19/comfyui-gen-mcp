<script>
  import { onDestroy, onMount, untrack } from 'svelte'
  import { api, formatBytes } from './api.js'
  import LoraSection from './LoraSection.svelte'
  import Models from './Models.svelte'

  // The settings: the extension's, for this computer, or the Worker's, for every GPU it has (PCs,
  // Modal or a ComfyUI URL). One config: Claude sees one set of tools. What differs per GPU is only
  // which models and LoRA files it has, shown per GPU below; keep-warm is set per GPU on Setup.
  let { info, refresh } = $props()
  // Read once: the page is remounted each time its tab is opened.
  const fixed = untrack(() => ({ info }))
  const machine = fixed.info.mode === 'local'
  const gpus = machine ? [] : fixed.info.gpus ?? []
  const anyPc = gpus.some((g) => g.kind === 'pc')

  const MP = 1024 * 1024

  // A working copy; saved as a whole.
  let cfg = $state($state.snapshot(fixed.info.config))
  let saving = $state(false)
  let message = $state('')
  let error = $state('')
  let warnings = $state([])
  let notes = $state([]) // informational (the PC offline), shown quietly
  let saves = $state(0) // remounts the model list after a save, which may start downloads

  function selectedPack(group) {
    const wanted = cfg.pack_selections[group.tool_name]
    return group.packs.find((p) => p.name === wanted) || group.packs.find((p) => p.is_default) || group.packs[0]
  }

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

  // The extension's own settings (keep-warm); a Worker's GPUs each have theirs on the Setup tab.
  const keepWarms = machine ? fixed.info.schema.filter((f) => f.machine) : []
  // The LoRA groups that have models, in order (the first takes LoRAs without a group): packs of a
  // group share its LoRAs (Anima and Anima Turbo). artistPrefix: its models take @artist tags, so
  // a LoRA's trigger is one too.
  const allPacks = fixed.info.packs.flatMap((g) => g.packs)
  const loraGroups = (fixed.info.lora_groups ?? [])
    .map((g) => ({ ...g, packs: allPacks.filter((p) => p.lora_group === g.id) }))
    .filter((g) => g.packs.length)
    .map((g) => ({ ...g, artistPrefix: g.packs.some((p) => p.default_artist_list?.trim().startsWith('@')) }))
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
        ? { backends: [got.external ? 'url' : 'machine'], files: Object.fromEntries(Object.entries(got.loras).map(([n, size]) => [n, { machine: size }])), syncing: {}, errors: {} }
        : got
      tagLoose()
    } catch (e) {
      loraListing = { backends: [], files: {}, syncing: {}, errors: { [machine ? 'machine' : 'the Worker']: e.message } }
    }
    // Every 3 s while copies run (or just after an upload or a save); every 20 s while a PC is
    // paired, so its going offline or coming back shows without a reload.
    const copying = Object.values(loraListing.syncing ?? {}).some((j) => !j.error)
    if (alive && (copying || Date.now() < watchUntil)) loraTimer = setTimeout(() => loadLoras(), 3000)
    else if (alive && anyPc) loraTimer = setTimeout(() => loadLoras(), 20_000)
  }
  onMount(() => loadLoras())

  // As the server does: a stored LoRA in no group joins the first, switched off. Done on this
  // working copy too, so saving it doesn't take a LoRA out of the group the server put it in.
  function tagLoose() {
    const into = loraGroups[0]?.id
    if (!into) return
    const grouped = new Set(Object.values(cfg.pack_loras).flat().map((e) => e.name))
    for (const [name, where] of Object.entries(loraListing.files ?? {})) {
      if (grouped.has(name) || !('storage' in where || 'machine' in where)) continue
      ;(cfg.pack_loras[into] ??= []).push({ name, strength: 1, trigger: '', hidden: false, enabled: false })
    }
  }

  async function save() {
    saving = true
    message = ''
    error = ''
    try {
      const saved = await api('PUT', '/config', { config: cfg })
      cfg = saved.config
      warnings = saved.warnings || []
      notes = saved.notes || []
      saves += 1
      message = machine
        ? 'Saved. Claude Desktop picks up the changes in a new chat (restart it if a chat still shows the old tools).'
        : "Saved. To pick up the changes, refresh the tool list in claude.ai's Customize menu; Claude Code and other apps pick them up in a new session."
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
    <h2>{group.title || group.tool_name}</h2>
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
        value={cfg.pack_settings[current.family]?.artist_list ?? ''}
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

{#if loraGroups.length}
  <section>
    <LoraSection {cfg} groups={loraGroups} listing={loraListing} reload={loadLoras} />
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
{#each notes as n}<p class="muted">{n}</p>{/each}
{#each warnings as w}<p class="err">{w}</p>{/each}
{#if error}<p class="err">{error}</p>{/if}

{#if machine || gpus.some((g) => g.kind !== 'url')}
  <section>{#key saves}<Models local={machine} />{/key}</section>
{/if}
