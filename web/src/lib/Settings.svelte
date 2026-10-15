<script>
  import { onDestroy, onMount, untrack } from 'svelte'
  import '../../../site/guide/wizard.css'
  import { api } from './api.js'
  import GpuList from './GpuList.svelte'
  import LoraSection from './LoraSection.svelte'
  import { ModelStatus } from './models.svelte.js'
  import SettingsModels from './SettingsModels.svelte'
  import SettingsWorker from './SettingsWorker.svelte'
  import { Task } from './task.svelte.js'
  import { tagLoras } from '../../../packages/core/src/config.ts'

  // The settings (design §5): the extension's, for this computer, or the Worker's, for every GPU it
  // has. One config: Claude sees one set of tools. In sections, one at a time under a bar:
  //   Models     a card per image tool: its model and options, and that model's downloads
  //   LoRAs      per model group
  //   GPUs       the Worker's GPU list (the Worker only)
  //   Worker     encryption, password, account (the Worker only)
  //   This computer  keep-warm (the extension only)
  // What the config holds (models, options, LoRA choices, keep-warm) is a working copy, saved with
  // the footer's Save, which shows only while something differs from the last save. Everything
  // else (uploads, downloads, GPUs, the Worker's settings) acts at once.
  // *onsetup* opens the Setup tab (adding a GPU is done there). *unsaved* (bindable): whether
  // something waits for Save, so the app can ask before leaving the tab.
  let { info, refresh, onsetup, unsaved = $bindable(false) } = $props()
  // Read once: the page is remounted each time its tab is opened.
  const fixed = untrack(() => ({ info }))
  const machine = fixed.info.mode === 'local'
  const anyPc = (fixed.info.gpus ?? []).some((g) => g.kind === 'pc')

  // The working copy, and the config as last saved (both tagged as the server tags LoRAs).
  const clone = (v) => JSON.parse(JSON.stringify(v))
  let saved = $state(clone(fixed.info.config))
  let cfg = $state(clone(fixed.info.config))
  let dirty = $derived(JSON.stringify(cfg) !== JSON.stringify(saved))
  $effect(() => {
    unsaved = dirty
  })
  const saving = new Task()
  let message = $state('') // after a save, for a while
  let warnings = $state([])

  // The extension's own settings (keep-warm); a Worker's GPUs each have theirs under GPUs.
  const keepWarms = machine ? fixed.info.schema.filter((f) => f.machine) : []
  const marks = fixed.info.schema.find((f) => f.key === 'remove_marks') ?? null
  // The LoRA groups that have models, in order (the first takes LoRAs without a group): packs of a
  // group share its LoRAs (Anima and Anima Turbo). artistPrefix: its models take @artist tags, so
  // a LoRA's trigger is one too.
  const allPacks = fixed.info.packs.flatMap((g) => g.packs)
  const loraGroups = (fixed.info.lora_groups ?? [])
    .map((g) => ({ ...g, packs: allPacks.filter((p) => p.lora_group === g.id) }))
    .filter((g) => g.packs.length)
    .map((g) => ({ ...g, artistPrefix: g.packs.some((p) => p.default_artist_list?.trim().startsWith('@')) }))

  // The sections this page has, and the one shown (#settings/<id>, so a reload stays on it).
  const SECTIONS = [
    { id: 'models', title: 'Models' },
    ...(loraGroups.length ? [{ id: 'loras', title: 'LoRAs' }] : []),
    ...(!machine ? [{ id: 'gpus', title: 'GPUs' }, { id: 'worker', title: 'Worker' }] : []),
    ...(keepWarms.length ? [{ id: 'computer', title: 'This computer' }] : []),
  ]
  const fromHash = () => SECTIONS.find((s) => location.hash === `#settings/${s.id}`)?.id ?? SECTIONS[0].id
  let section = $state(fromHash())
  function show(id) {
    section = id
    history.replaceState(null, '', `#settings/${id}`)
    window.scrollTo(0, 0)
  }

  // What differs from the last save, in words, for the footer.
  let changes = $derived.by(() => {
    if (!dirty) return []
    const out = []
    for (const group of fixed.info.packs) {
      const title = group.title || group.tool_name
      if (cfg.pack_selections[group.tool_name] !== saved.pack_selections[group.tool_name]) out.push(`${title}: model`)
      const families = new Set(group.packs.map((p) => p.family))
      if ([...families].some((f) => JSON.stringify(cfg.pack_settings[f] ?? {}) !== JSON.stringify(saved.pack_settings[f] ?? {})))
        out.push(`${title}: options`)
    }
    const loras = (c) => Object.fromEntries(Object.entries(c.pack_loras ?? {}).flatMap(([g, list]) => list.map((e) => [e.name, JSON.stringify([g, e])])))
    const [now, then] = [loras(cfg), loras(saved)]
    const changed = new Set([...Object.keys(now), ...Object.keys(then)].filter((n) => now[n] !== then[n])).size
    if (changed) out.push(changed === 1 ? '1 LoRA' : `${changed} LoRAs`)
    if (marks && cfg.remove_marks !== saved.remove_marks) out.push('watermark removal')
    for (const f of keepWarms) if (cfg[f.key] !== saved[f.key]) out.push(f.title)
    return out.length ? out : ['settings']
  })

  // LoRA files on each backend. This computer's list is mapped to the Worker's shape.
  let loraListing = $state(null)
  // While the agent copies LoRAs, or for a while after an upload or a save (a copy may be about to
  // start), the list checks again every 3 s.
  let watchUntil = 0
  let loraTimer = null
  let alive = true

  async function loadLoras(watch = false) {
    if (watch) watchUntil = Date.now() + 30_000
    clearTimeout(loraTimer)
    try {
      const got = await api('GET', '/loras')
      loraListing = machine
        ? { backends: ['machine'], files: Object.fromEntries(Object.entries(got.loras).map(([n, size]) => [n, { machine: size }])), syncing: {}, errors: {} }
        : got
      tagLoose(cfg)
      tagLoose(saved)
    } catch (e) {
      loraListing = { backends: [], files: {}, syncing: {}, errors: { [machine ? 'machine' : 'the Worker']: e.message } }
    }
    // Every 3 s while copies run (or just after an upload or a save); every 20 s while a PC is
    // paired, so its going offline or coming back shows without a reload.
    const copying = Object.values(loraListing.syncing ?? {}).some((j) => !j.error)
    if (alive && (copying || Date.now() < watchUntil)) loraTimer = setTimeout(() => loadLoras(), 3000)
    else if (alive && anyPc) loraTimer = setTimeout(() => loadLoras(), 20_000)
  }

  // As the server does (core tagLoras): a stored LoRA in no group joins the first, switched off. Done
  // on the working copy and the saved one alike, so it neither reads as an unsaved change nor, saved,
  // takes a LoRA out of the group the server put it in.
  function tagLoose(config) {
    const into = loraGroups[0]?.id
    if (!into) return
    const stored = Object.entries(loraListing.files ?? {}).filter(([, where]) => 'storage' in where || 'machine' in where)
    const tagged = tagLoras(config.pack_loras, stored.map(([name]) => name), into)
    if (tagged) config.pack_loras = tagged
  }

  // The chosen models' downloads, for the cards: one poll for all of them.
  const models = new ModelStatus()

  let messageTimer = null
  function save() {
    message = ''
    saving.run(async () => {
      const got = await api('PUT', '/config', { config: cfg })
      saved = clone(got.config)
      cfg = clone(got.config)
      warnings = got.warnings || []
      message = machine
        ? 'Saved. Claude Desktop picks up the changes in a new chat (restart it if a chat still shows the old tools).'
        : "Saved. Refresh the tool list in claude.ai's Customize menu to pick up the changes; Claude Code and other apps do in a new session."
      clearTimeout(messageTimer)
      messageTimer = setTimeout(() => (message = ''), 10_000)
      await refresh()
      await loadLoras(true) // saving copies LoRAs from storage to every GPU
      models.start() // and downloads: check now
    })
  }

  function discard() {
    cfg = clone(saved)
    saving.error = ''
  }

  // Leaving with unsaved changes asks first.
  function beforeunload(e) {
    if (dirty) e.preventDefault()
  }

  onMount(() => {
    loadLoras()
    models.start()
  })
  onDestroy(() => {
    alive = false
    clearTimeout(loraTimer)
    clearTimeout(messageTimer)
    models.stop()
  })
</script>

<svelte:window onbeforeunload={beforeunload} onhashchange={() => (section = fromHash())} />

<div class="st">
  <nav class="wz-bar st-bar" aria-label="Settings sections">
    {#each SECTIONS as s (s.id)}
      <button type="button" class:current={s.id === section} aria-current={s.id === section ? 'page' : undefined} onclick={() => show(s.id)}>{s.title}</button>
    {/each}
  </nav>

  <div class="st-body">
    {#if warnings.length}
      <div class="notice">
        {#each warnings as w}<p class="err">{w}</p>{/each}
        <button type="button" class="link" onclick={() => (warnings = [])}>Dismiss</button>
      </div>
    {/if}

    {#if section === 'models'}
      <SettingsModels bind:cfg {saved} packs={fixed.info.packs} status={models} {marks} />
    {:else if section === 'loras'}
      <section>
        <LoraSection {cfg} groups={loraGroups} listing={loraListing} reload={loadLoras} />
      </section>
    {:else if section === 'gpus'}
      <section>
        <h2>GPUs</h2>
        <GpuList gpus={info.gpus ?? []} {refresh} />
        <p class="muted">
          To add a PC or Modal, use
          <button type="button" class="link" onclick={onsetup}>the Setup tab</button>.
        </p>
      </section>
    {:else if section === 'worker'}
      <SettingsWorker {info} {refresh} />
    {:else if section === 'computer'}
      {#each keepWarms as f (f.key)}
        <section>
          <h2>{f.title}</h2>
          <p class="muted">{f.description}</p>
          <input type="number" min={f.min} max={f.max} bind:value={cfg[f.key]} />
        </section>
      {/each}
    {/if}
  </div>

  {#if dirty || saving.busy || message || saving.error}
    <footer class="st-foot">
      {#if dirty}
        <p><b>Unsaved changes:</b> <span class="muted">{changes.join(', ')}</span></p>
      {:else if message}
        <p class="ok">{message}</p>
      {/if}
      {#if saving.error}<p class="err">{saving.error}</p>{/if}
      {#if dirty || saving.busy}
        <span class="buttons">
          <button type="button" class="secondary" onclick={discard} disabled={saving.busy}>Discard</button>
          <button type="button" onclick={save} disabled={saving.busy}>{saving.busy ? 'Saving…' : 'Save settings'}</button>
        </span>
      {/if}
    </footer>
  {/if}
</div>

<style>
  .st {
    display: flex;
    flex-direction: column;
    min-height: calc(100dvh - var(--app-top, 0px));
  }
  /* The section bar: Setup's step bar, as plain tabs. */
  .st-bar {
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 4px;
  }
  .st-bar button {
    margin: 0;
    padding: 6px 14px;
    border-radius: 999px;
    font: inherit;
    font-size: 0.92rem;
    background: none;
    border: 1px solid transparent;
    color: var(--muted);
    white-space: nowrap;
  }
  .st-bar button.current {
    color: var(--text);
    border-color: var(--accent);
    font-weight: 600;
  }
  .st-body {
    box-sizing: border-box;
    width: 100%;
    max-width: 1280px;
    margin: 0 auto;
    padding: 20px 20px 32px;
    flex: 1;
  }
  .st-body > :global(section) {
    margin-top: 0;
  }
  .notice {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px 14px 10px;
    margin: 0 0 16px;
    background: var(--panel);
  }
  .notice p {
    margin: 6px 0;
  }
  /* The save bar: only while something waits for Save (or just after). */
  .st-foot {
    position: sticky;
    bottom: 0;
    z-index: 20;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 16px;
    padding: 12px max(20px, calc((100% - 1240px) / 2));
    background: var(--bg);
    border-top: 1px solid var(--border);
  }
  .st-foot p {
    margin: 0;
    flex: 1 1 280px;
  }
  .st-foot .buttons {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  .st-foot button {
    margin: 0;
  }
</style>
