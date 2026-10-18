<script>
  import { strengthIn } from '../../../packages/core/src/config.ts'
  import { detectLora, loraHeaderLength } from '../../../packages/core/src/lora-detect.ts'
  import { api, formatBytes } from './api.js'
  import { uploadLora } from './upload.js'
  import Icon from './Icon.svelte'

  // One place for LoRAs, a table: each file, its setup, its size and where it is. A LoRA belongs to
  // one group, the model family it was trained for (Anima and Anima Turbo share theirs, as do Flux 2
  // Klein 4B and its Edit); the Model family list at the top picks the group shown
  // (#settings/loras/<group> opens one). An upload is filed under the family its file says it is
  // for (core lora-detect.ts). *cfg* is the page's working config: its pack_loras ({group: [{name,
  // strength, strengths?, trigger, hidden, enabled}]}) is edited in place and saved with the page.
  // Each model of the group has its own strength column (they take LoRAs differently): strengths
  // {pack: n}, folded back into plain strength while every model has the same. *groups* are the LoRA
  // groups that have models, [{id, title, packs, artistPrefix, base_models, match}], the first being where a LoRA
  // without a group goes. *listing* is null while loading, then
  //   {backends, gpus: [{id, name, kind}], files: {name: {backend: size}}, syncing: {name: {to, done,
  //    total, error}}, errors, offline: backends not reachable now (a PC off), nothing listed for them}
  // with backends among:
  //   machine  this computer (the Claude Desktop extension)
  //   storage  the Worker's R2 storage: every LoRA comes in here, and every GPU copies from it
  //   <id>     one of the Worker's GPUs (gpus says its name and kind): a PC or the Modal Volume
  // One way in: every LoRA comes through Upload LoRA, into storage (or this computer's folder on the
  // extension), and the Worker copies it to each GPU. Only LoRAs that came in this way are listed,
  // never others that happen to be in a PC's folders.
  // *reload(watch)*: list again; watch keeps re-checking for a while (a copy to the PC may follow).
  let { cfg, groups, listing, reload } = $props()

  const fromHash = () => /^#settings\/loras\/([\w-]+)/.exec(location.hash)?.[1]
  let tab = $state(groups.find((g) => g.id === fromHash())?.id ?? groups[0]?.id)
  let group = $derived(groups.find((g) => g.id === tab) ?? groups[0])
  function open(id) {
    tab = id
    history.replaceState(null, '', `#settings/loras/${id}`)
  }

  // A family is in use when one of its models is selected (else the tool's default is).
  const chosen = (p) => (cfg.pack_selections[p.tool_name] ?? p.tool_default) === p.name
  const inUse = (g) => g.packs.some(chosen)
  const enabledIn = (g) => (cfg.pack_loras[g.id] ?? []).filter((e) => e.enabled).length
  const label = (g) => {
    const n = enabledIn(g)
    return `${g.title}${n ? ` (${n} on)` : ''}${inUse(g) ? '' : ', not selected'}`
  }

  let progress = $state(null) // {name, phase, done, total} while an upload runs
  let error = $state('')
  let note = $state('')

  let backends = $derived(listing?.backends ?? [])
  let gpus = $derived(listing?.gpus ?? [])
  const place = (b) => (b === 'storage' ? 'Stored' : gpus.find((g) => g.id === b)?.name ?? '')
  let files = $derived(listing?.files ?? {})
  let has = (b) => backends.includes(b)
  let hasKind = (k) => gpus.some((g) => g.kind === k)
  let offline = $derived((listing?.offline ?? []).map(place).filter(Boolean))
  // Uploads go to the Worker's storage, or to this computer on the extension's page.
  let canUpload = $derived(has('storage') || has('machine'))

  const stem = (name) => (name || '').replace(/\.safetensors$/i, '')

  // A training run's suffixes are no part of a trigger: huke-step00000900 is @huke, and
  // ashraely_v6-step00001200 is @ashraely. Only after a separator, so style2 stays style2.
  const SUFFIX = /[-_. ](?:(?:step|epoch|ep|e|s)?\d+|v\d+(?:\.\d+)*)$/i
  const bare = (s) => {
    let out = s
    while (SUFFIX.test(out)) out = out.replace(SUFFIX, '')
    return out || s
  }

  // Anima's artist styles are @tags, and so are the triggers of style LoRAs made for it.
  const triggerFor = (g, name) => {
    const s = bare(stem(name))
    return g.artistPrefix && !s.startsWith('@') ? `@${s}` : s
  }

  const entries = (g) => cfg.pack_loras[g.id] ?? []
  const entryOf = (g, name) => entries(g).find((e) => e.name === name)
  const grouped = (name) => groups.some((g) => entryOf(g, name))

  // The LoRAs shown for a family: its group's, then, in the first, any listed file in no group (a
  // copy on a GPU from before storage; one in storage the page has already put in a group).
  const namesIn = (g) => {
    const out = entries(g).map((e) => e.name)
    if (g.id === groups[0]?.id) for (const n of Object.keys(files)) if (!grouped(n) && !out.includes(n)) out.push(n)
    return out
  }
  let names = $derived(group ? namesIn(group) : [])

  // On or off in *g*. Turned on with no trigger yet, it gets *trigger* (the file's own), else one
  // from the file name.
  function toggle(g, name, on, trigger = '') {
    cfg.pack_loras[g.id] ??= []
    const entry = entryOf(g, name)
    if (!entry) cfg.pack_loras[g.id].push({ name, strength: 1, trigger: on ? trigger || triggerFor(g, name) : '', hidden: false, enabled: on })
    else {
      if (on && !entry.enabled && !entry.trigger) entry.trigger = trigger || triggerFor(g, name)
      entry.enabled = on
    }
  }

  // The family a file says it is for, from its safetensors header (read here, before uploading):
  // {group, foreign, base, trigger}, or null when it can't tell.
  async function familyOf(file) {
    try {
      const n = loraHeaderLength(new Uint8Array(await file.slice(0, 8).arrayBuffer()))
      return n ? detectLora(JSON.parse(await file.slice(8, 8 + n).text()), groups) : null
    } catch {
      return null
    }
  }

  // Out of every group (a deleted file).
  function drop(name) {
    for (const g of groups) {
      const list = cfg.pack_loras[g.id]
      const i = list?.findIndex((e) => e.name === name) ?? -1
      if (i >= 0) list.splice(i, 1)
    }
  }

  // To another group, switched off there: a LoRA filed under the wrong models.
  function move(name, to) {
    const target = groups.find((g) => g.id === to)
    if (!target) return
    const entry = groups.map((g) => entryOf(g, name)).find(Boolean)
    drop(name)
    cfg.pack_loras[to] ??= []
    cfg.pack_loras[to].push({ ...(entry ?? { name, strength: 1, trigger: '', hidden: false }), enabled: false })
  }

  async function pick(e) {
    const file = e.currentTarget.files[0]
    e.currentTarget.value = ''
    if (!file) return
    error = ''
    if (files[file.name] && !confirm(`${file.name} is already uploaded. Replace it?`)) return
    note = ''
    // Into the family the file says it is for, else the open one (the server files it there too,
    // off until this page saves it on); the Worker then copies it to each GPU.
    const found = await familyOf(file)
    const detected = groups.find((g) => g.id === found?.group)
    if (!detected && found?.foreign) {
      const made = found.base ? ` for ${found.base}` : ' for another model'
      if (!confirm(`${file.name} looks made${made}, none of these model families, so it likely won't work. Upload it to ${group.title} anyway?`)) return
    }
    const into = detected ?? group
    if (detected && detected.id !== group?.id) {
      open(detected.id)
      note = `${file.name} is a ${detected.title} LoRA (its file says so): it is filed under ${detected.title}.`
    }
    try {
      await uploadLora(file, (p) => (progress = { name: file.name, ...p }), into?.id)
      if (into) {
        if (grouped(file.name) && !entryOf(into, file.name)) move(file.name, into.id)
        toggle(into, file.name, true, found?.trigger ?? '')
      }
    } catch (err) {
      error = `${file.name}: ${err.message}`
    } finally {
      progress = null
      await reload(true) // also after an error: the file may have arrived regardless
    }
  }

  let deleting = $state(null) // the file being deleted, until the list shows it gone

  async function remove(name) {
    const where = has('storage') ? ' from storage and every GPU' : ''
    if (!confirm(`Delete ${name}${where}? Models that use it stop using it.`)) return
    error = ''
    note = ''
    deleting = name
    try {
      const r = await api('DELETE', `/loras/${encodeURIComponent(name)}`)
      if (r.errors?.length) error = r.errors.join(' ')
      // Windows: ComfyUI still had the file open. It is off the list; the file goes when ComfyUI stops.
      // The extension answers pending: true/false; the Worker, the names of the PCs concerned.
      const busy = r.pending === true ? ['ComfyUI'] : Array.isArray(r.pending) ? r.pending.map((pc) => `ComfyUI on ${pc}`) : []
      if (busy.length) note = `${name} is deleted. ${busy.join(' and ')} still had its file open: the file is removed when ComfyUI next stops.`
      drop(name)
      await reload()
    } catch (err) {
      error = err.message
    } finally {
      deleting = null
    }
  }

  // One model's strength. Another value than the others' keeps a strengths map (strength stays the
  // first model's, what a version before per-model strengths reads); all equal, it is plain strength.
  function setStrength(g, entry, pack, value) {
    const n = Number(value)
    if (value === '' || value === null || !Number.isFinite(n)) return // mid-typing
    const packs = g.packs.map((p) => p.name)
    const all = Object.fromEntries(packs.map((p) => [p, p === pack ? n : strengthIn(entry, p)]))
    const values = Object.values(all)
    entry.strength = all[packs[0]] ?? n
    if (values.every((v) => v === values[0])) delete entry.strengths
    else entry.strengths = all
  }

  // A file's size, once: its stored copy's, else any copy's.
  const sizeOf = (name) => {
    const at = files[name] ?? {}
    const size = at.storage ?? Object.values(at)[0]
    return size === undefined ? '' : formatBytes(size)
  }

  // Where a file is, per listed backend: there, a copy in progress, or missing.
  function mark(name, where) {
    const size = files[name]?.[where]
    if (size !== undefined) return { ok: true, text: '✓' }
    const job = listing?.syncing?.[name]
    if (job && job.to === where) {
      if (job.error) return { err: true, text: `copy failed: ${job.error}` }
      return { text: `copying${job.total ? ` ${Math.floor((100 * job.done) / job.total)}%` : '…'}` }
    }
    if (listing?.offline?.includes(where)) return { text: 'offline' }
    if (listing?.errors?.[where]) return { text: '?' }
    // Missing matters only for a LoRA some model uses (it is then copied over on save).
    return { err: groups.some((g) => entryOf(g, name)?.enabled), text: '—' }
  }

  let packs = $derived(group?.packs ?? [])
  let packNames = $derived(packs.map((p) => p.display_name).join(', '))
  // The table's columns: file (with Move to… under it, with several families), enabled, a strength
  // per model, trigger, hidden, size, each place, delete.
  let columns = $derived(
    [
      'minmax(130px, 2fr)', 'auto', ...packs.map(() => 'minmax(56px, 80px)'), 'minmax(100px, 1fr)', 'auto', 'auto',
      ...backends.map(() => 'auto'), '44px',
    ].join(' '),
  )
  const placeName = (b) => place(b) || 'This computer'
  // With one group, no family list: the section is that group's list.
  let several = $derived(groups.length > 1)
  let errors = $derived(Object.entries(listing?.errors ?? {}).map(([b, m]) => `${place(b) || b}: ${m}`))
</script>

<h2>LoRAs</h2>
{#if several}
  <div class="family">
    <label for="lora-family">Model family</label>
    <select id="lora-family" value={tab} onchange={(e) => open(e.currentTarget.value)}>
      {#each groups as g (g.id)}<option value={g.id}>{label(g)}</option>{/each}
    </select>
  </div>
{/if}
<p class="muted">
  {several ? 'A LoRA works only with the model family it was trained for. ' : ''}{packNames === group.title ? '' : `For ${packNames}. `}
  Tick Enabled to use a LoRA. With a trigger it applies only when the prompt contains that word, and Claude is told
  the trigger unless the LoRA is hidden; without one it always applies.{packs.length > 1 ? ' Strength is per model: they take LoRAs differently.' : ''}
  Save to apply.
</p>
{#if has('storage')}
  <p class="muted">Uploads are kept in this Worker's storage and copied to each GPU from there.</p>
{:else if has('machine')}
  <p class="muted">Uploads go to ComfyUI's LoRAs folder on this computer.</p>
{/if}
{#if hasKind('modal')}
  <p class="muted">A GPU that is already running picks up a new LoRA once it is idle.</p>
{/if}
{#if offline.length}
  <p class="muted">{offline.join(', ')} {offline.length > 1 ? 'are' : 'is'} offline: new LoRAs are copied when next online.</p>
{/if}

{#if !listing}
  <p class="muted">Loading…</p>
{:else if !names.length}
  <p class="muted">{backends.length ? 'None yet.' : 'None added yet.'}</p>
{/if}

{#if names.length}
  <div class="scroll">
  <div class="table" role="table" aria-label="LoRAs" style="grid-template-columns: {columns}">
    <div class="tr th" role="row">
      <span role="columnheader">File</span>
      <span role="columnheader" class="center">Enabled</span>
      {#each packs as p (p.name)}<span role="columnheader" title="Strength with {p.display_name}">{p.display_name}</span>{/each}
      <span role="columnheader">Trigger</span>
      <span role="columnheader" class="center">Hidden</span>
      <span role="columnheader" class="num">Size</span>
      {#each backends as where (where)}<span role="columnheader">{placeName(where)}</span>{/each}
      <span role="columnheader" aria-label="Delete"></span>
    </div>
    {#each names as name (name)}
      {@const entry = entryOf(group, name)}
      <div class="tr" role="row">
        <span class="name" role="cell">
          <b>{name}</b>
          {#if several}
            <select class="move" aria-label="Move {name} to another model family" value="" onchange={(e) => (move(name, e.currentTarget.value), (e.currentTarget.value = ''))}>
              <option value="" disabled>Move to…</option>
              {#each groups.filter((g) => g.id !== group.id) as g (g.id)}<option value={g.id}>{g.title}</option>{/each}
            </select>
          {/if}
        </span>
        <label class="use center" role="cell" data-label="Enabled"><input type="checkbox" checked={!!entry?.enabled} onchange={(e) => toggle(group, name, e.currentTarget.checked)} aria-label="Enabled" /></label>
        {#each packs as p (p.name)}
          <span role="cell" data-label="Strength, {p.display_name}" class:off={!entry?.enabled}>
            {#if entry?.enabled}
              <input class="strength" type="number" min="-5" max="5" step="0.1" value={strengthIn(entry, p.name)} oninput={(e) => setStrength(group, entry, p.name, e.currentTarget.value)} aria-label="Strength with {p.display_name}" />
            {/if}
          </span>
        {/each}
        <span role="cell" data-label="Trigger" class:off={!entry?.enabled}>
          {#if entry?.enabled}<input class="trigger" type="text" bind:value={entry.trigger} placeholder="always on" aria-label="Trigger" />{/if}
        </span>
        <span role="cell" class="center" data-label="Hidden" class:off={!entry?.enabled}>
          {#if entry?.enabled}<input type="checkbox" bind:checked={entry.hidden} aria-label="Hidden" />{/if}
        </span>
        <span role="cell" class="num muted" data-label="Size">{sizeOf(name)}</span>
        {#each backends as where (where)}
          {@const m = mark(name, where)}
          <span role="cell" class="place" class:ok={m.ok} class:err={m.err} class:muted={!m.ok && !m.err} data-label={placeName(where)}>{m.text}</span>
        {/each}
        <span role="cell" class="del">
          {#if files[name] && backends.length}
            <button type="button" class="danger small icon-btn" onclick={() => remove(name)} disabled={!!progress || deleting !== null} title="Delete {name}" aria-label="Delete {name}">
              {#if deleting === name}…{:else}<Icon name="trash" />{/if}
            </button>
          {/if}
        </span>
      </div>
    {/each}
  </div>
  </div>
{/if}

{#if progress}
  <p>
    Uploading {progress.name}…
    <span class="muted">{formatBytes(progress.done) || '0 MB'} of {formatBytes(progress.total)}</span>
  </p>
  <progress max={progress.total} value={progress.done}></progress>
{:else}
  {#if canUpload}
    <label class="upload">
      <span class="button">Upload LoRA</span>
      <input type="file" accept=".safetensors" onchange={pick} />
    </label>
  {/if}
{/if}
{#if note}<p class="muted">{note}</p>{/if}
{#if error}<p class="err">{error}</p>{/if}
{#each errors as e}<p class="err">{e}</p>{/each}

<style>
  /* A grid table: the rows share the header's columns (display: contents). Every cell stretches to
   * its row's height, so the row lines meet, and centres what it holds. */
  /* Many columns (a strength per model, a place per GPU) scroll inside the card, not past it. */
  .scroll { overflow-x: auto; }
  .table { display: grid; column-gap: 10px; margin-top: 8px; }
  .tr { display: contents; }
  .tr > * { display: flex; align-items: center; min-height: 40px; padding: 6px 0; border-top: 1px solid var(--border); min-width: 0; margin: 0; }
  /* Headers wrap (two strength columns, Flux 2 Klein 4B and its Edit) and keep their words' width. */
  .th > * { border-top: 0; min-height: 0; padding-top: 0; font-size: 0.85rem; color: var(--muted); font-weight: 600; min-width: auto; align-items: flex-end; }
  .name { overflow-wrap: anywhere; flex-direction: column; align-items: flex-start; justify-content: center; gap: 2px; }
  .num { justify-content: flex-end; }
  .center { justify-content: center; }
  .place { white-space: nowrap; }
  .num { white-space: nowrap; }
  .use { font-weight: normal; }
  .tr input[type='checkbox'] { margin: 0; }
  .strength, .trigger { width: 100%; margin: 0; }
  .del button { margin: 0; padding: 4px 8px; }
  .move { width: auto; max-width: 100%; margin: 0; padding: 0 2px; font-size: 0.8rem; color: var(--muted); background: transparent; border-color: transparent; }
  .move:hover, .move:focus { border-color: var(--border); }
  progress { width: 100%; }
  .upload { display: inline-block; margin-top: 10px; font-weight: normal; }
  .family { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 8px; }
  .family label { margin: 0; font-weight: 600; }
  .family select { width: auto; margin: 0; }
  .upload input { display: none; }
  /* Narrow: a card per file, each value on its own labelled line. */
  @media (max-width: 760px) {
    .table { display: block; }
    .tr { display: block; border-top: 1px solid var(--border); padding: 8px 0; }
    .tr.th { display: none; }
    .tr > * { border-top: 0; min-height: 34px; padding: 2px 0; justify-content: space-between; }
    .tr > [data-label]::before { content: attr(data-label); color: var(--muted); font-size: 0.85rem; font-weight: normal; margin-right: 12px; }
    .tr > .off { display: none; }
    .strength { width: 90px; }
    .trigger { width: 60%; }
  }
</style>
