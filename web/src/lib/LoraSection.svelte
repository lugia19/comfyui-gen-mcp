<script>
  import { api, formatBytes } from './api.js'
  import { uploadLora } from './upload.js'

  // One place for LoRAs: each file, where it is, and its setup beside it. A LoRA belongs to one
  // group, the models it was trained for (Anima and Anima Turbo share theirs); with several groups,
  // each is a tab. *cfg* is the page's working config: its pack_loras ({group: [{name, strength,
  // trigger, hidden, enabled}]}) is edited in place and saved with the page. *groups* are the LoRA
  // groups that have models, [{id, title, packs, artistPrefix}], the first being where a LoRA
  // without a group goes. *listing* is null while loading, then
  //   {backends, gpus: [{id, name, kind}], files: {name: {backend: size}}, syncing: {name: {to, done,
  //    total, error}}, errors, offline: backends not reachable now (a PC off), nothing listed for them}
  // with backends among:
  //   machine  this computer (the Claude Desktop extension)
  //   storage  the Worker's R2 storage: every LoRA comes in here, and every GPU copies from it
  //   <id>     one of the Worker's GPUs (gpus says its name and kind): a PC, the Modal Volume, or a
  //            ComfyUI by URL, which has no listing (a file is added by name)
  //   url      the extension's own ComfyUI by URL (the same)
  // One way in: every LoRA comes through Upload LoRA, into storage (or this computer's folder on the
  // extension), and the Worker copies it to each GPU. Only LoRAs that came in this way are listed,
  // never others that happen to be in a PC's folders.
  // *reload(watch)*: list again; watch keeps re-checking for a while (a copy to the PC may follow).
  let { cfg, groups, listing, reload } = $props()

  let tab = $state(groups[0]?.id)
  let group = $derived(groups.find((g) => g.id === tab) ?? groups[0])

  let progress = $state(null) // {name, phase, done, total} while an upload runs
  let error = $state('')
  let note = $state('')
  let typed = $state('')

  let backends = $derived(listing?.backends ?? [])
  let gpus = $derived(listing?.gpus ?? [])
  const kindOf = (b) => gpus.find((g) => g.id === b)?.kind
  const place = (b) => (b === 'storage' ? 'Stored' : gpus.find((g) => g.id === b)?.name ?? '')
  let listed = $derived(backends.filter((b) => b !== 'url' && kindOf(b) !== 'url'))
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

  // The LoRAs shown in a tab: its group's, then, in the first tab, any listed file in no group (a
  // copy on a GPU from before storage; one in storage the page has already put in a group).
  const namesIn = (g) => {
    const out = entries(g).map((e) => e.name)
    if (g.id === groups[0]?.id) for (const n of Object.keys(files)) if (!grouped(n) && !out.includes(n)) out.push(n)
    return out
  }
  let names = $derived(group ? namesIn(group) : [])

  // On or off in *g*. Turned on with no trigger yet, it gets one from the file name.
  function toggle(g, name, on) {
    cfg.pack_loras[g.id] ??= []
    const entry = entryOf(g, name)
    if (!entry) cfg.pack_loras[g.id].push({ name, strength: 1, trigger: on ? triggerFor(g, name) : '', hidden: false, enabled: on })
    else {
      if (on && !entry.enabled && !entry.trigger) entry.trigger = triggerFor(g, name)
      entry.enabled = on
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

  function addTyped() {
    const name = typed.trim()
    if (!name || !group) return
    if (!grouped(name)) toggle(group, name, true)
    typed = ''
  }

  async function pick(e) {
    const file = e.currentTarget.files[0]
    e.currentTarget.value = ''
    if (!file) return
    error = ''
    if (files[file.name] && !confirm(`${file.name} is already uploaded. Replace it?`)) return
    try {
      // Into the open tab's group (the server files it there too, off until this page saves it on);
      // the Worker then copies it to each GPU.
      const into = group
      await uploadLora(file, (p) => (progress = { name: file.name, ...p }), into?.id)
      if (into) {
        if (grouped(file.name) && !entryOf(into, file.name)) move(file.name, into.id)
        toggle(into, file.name, true)
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

  // Where a file is, per listed backend: its size, a copy in progress, or missing.
  function mark(name, where) {
    const size = files[name]?.[where]
    if (size !== undefined) return { ok: true, text: `✓ ${formatBytes(size)}` }
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

  let packNames = $derived((group?.packs ?? []).map((p) => p.display_name).join(', '))
  // With one group (Anima's), no tabs: the section is that group's list.
  let tabs = $derived(groups.length > 1)
  let errors = $derived(Object.entries(listing?.errors ?? {}).map(([b, m]) => `${place(b) || b}: ${m}`))
</script>

<h2>LoRAs</h2>
{#if tabs}
  <nav class="tabs" aria-label="LoRA groups">
    {#each groups as g (g.id)}
      <button type="button" class:active={g.id === tab} aria-pressed={g.id === tab} onclick={() => (tab = g.id)}>{g.title}</button>
    {/each}
  </nav>
{/if}
<p class="muted">
  {tabs ? 'A LoRA works only with the models it was trained for: each tab is one group of models. ' : ''}For {packNames}.
  Tick Enabled to use a LoRA. With a trigger it applies only when the prompt contains that word, and Claude is told
  the trigger unless the LoRA is hidden; without one it always applies. Save to apply.
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
  <p class="muted">{listed.length ? 'None yet.' : 'None added yet.'}</p>
{/if}

{#each names as name (name)}
  {@const entry = entryOf(group, name)}
  <div class="file">
    <div class="row head">
      <b class="name">{name}</b>
      {#each listed as where (where)}
        {@const m = mark(name, where)}
        <span class="place" class:ok={m.ok} class:err={m.err} class:muted={!m.ok && !m.err}>{#if place(where)}<b>{place(where)}</b>&nbsp;{/if}{m.text}</span>
      {/each}
      {#if files[name] && listed.length}
        <button class="secondary" onclick={() => remove(name)} disabled={!!progress || deleting !== null}>
          {deleting === name ? 'Deleting…' : 'Delete'}
        </button>
      {/if}
    </div>
    <div class="row pack">
      <label class="use"><input type="checkbox" checked={!!entry?.enabled} onchange={(e) => toggle(group, name, e.currentTarget.checked)} /> Enabled</label>
      {#if entry?.enabled}
        <input class="strength" type="number" min="-5" max="5" step="0.1" bind:value={entry.strength} aria-label="Strength" title="Strength" />
        <input class="trigger" type="text" bind:value={entry.trigger} placeholder="always on" aria-label="Trigger" title="Trigger word" />
        <label class="hidden"><input type="checkbox" bind:checked={entry.hidden} /> Hidden</label>
      {/if}
      {#if tabs}
        <select class="move" aria-label="Move to another group" value="" onchange={(e) => (move(name, e.currentTarget.value), (e.currentTarget.value = ''))}>
          <option value="" disabled>Move to…</option>
          {#each groups.filter((g) => g.id !== group.id) as g (g.id)}<option value={g.id}>{g.title}</option>{/each}
        </select>
      {/if}
    </div>
  </div>
{/each}

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
{#if has('url') || hasKind('url')}
  <div class="row">
    <input type="text" bind:value={typed} placeholder="file.safetensors" aria-label="LoRA file name" />
    <button class="secondary" onclick={addTyped} disabled={!typed.trim()}>Add</button>
  </div>
{/if}
{#if note}<p class="muted">{note}</p>{/if}
{#if error}<p class="err">{error}</p>{/if}
{#each errors as e}<p class="err">{e}</p>{/each}

<style>
  .file { border-top: 1px solid var(--border); padding: 8px 0; }
  .head { gap: 4px 14px; }
  .head button { margin-top: 0; }
  .name { flex: 1; overflow-wrap: anywhere; min-width: 160px; }
  .place { white-space: nowrap; }
  .pack { margin: 4px 0 0 4px; flex-wrap: nowrap; }
  .use { display: flex; gap: 6px; align-items: center; margin: 0; font-weight: normal; min-width: 130px; }
  .pack .strength { width: 72px; }
  .pack .trigger { width: 150px; }
  .hidden { display: flex; gap: 4px; align-items: center; margin: 0; font-weight: normal; white-space: nowrap; }
  progress { width: 100%; }
  .upload { display: inline-block; margin-top: 10px; font-weight: normal; }
  .tabs { margin: 0 0 8px; flex-wrap: wrap; }
  .move { width: auto; margin: 0 0 0 auto; }
  .upload input { display: none; }
  @media (max-width: 560px) { .pack { flex-wrap: wrap; } }
</style>
