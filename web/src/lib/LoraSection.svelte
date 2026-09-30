<script>
  import { api, formatBytes } from './api.js'
  import { uploadLora } from './upload.js'

  // One place for LoRAs: each file, where it is, and its setup per pack beside it. *cfg* is the
  // page's working config (its pack_loras is edited in place and saved with the page). *packs* are
  // the packs that take LoRAs. *listing* is null while loading, then
  //   {backends, files: {name: {backend: size}}, syncing: {name: {to, done, total, error}}, errors,
  //    offline: backends not reachable now (the PC off), nothing listed for them}
  // with backends among:
  //   machine  this computer (the Claude Desktop extension)
  //   pc       the Worker's paired PC, listed through the agent
  //   modal    the Modal Volume
  //   url      a ComfyUI reached by URL: no listing, a file is added by name
  // One way in: every LoRA comes through Upload LoRA. With a PC and Modal it goes to the Volume, and
  // the agent copies it to the PC; with a PC alone it goes to the PC through the Worker. Only LoRAs
  // that came in this way are listed, never others that happen to be in a PC's folders.
  // *reload(watch)*: list again; watch keeps re-checking for a while (a copy to the PC may follow).
  let { cfg, packs, listing, reload } = $props()

  let progress = $state(null) // {name, phase, done, total} while an upload runs
  let error = $state('')
  let typed = $state('')

  const PLACE = { pc: 'PC', modal: 'Modal' }
  let backends = $derived(listing?.backends ?? [])
  let listed = $derived(backends.filter((b) => b !== 'url'))
  let files = $derived(listing?.files ?? {})
  let has = (b) => backends.includes(b)
  // Where an upload goes: Modal when there is one (the agent then copies it), else the PC through
  // the Worker, else this computer (the extension).
  let uploadBase = $derived(has('modal') ? '/loras' : has('pc') ? '/pc/loras' : has('machine') ? '/loras' : null)

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
  const triggerFor = (pack, name) => {
    const s = bare(stem(name))
    return pack.default_artist_list?.trim().startsWith('@') && !s.startsWith('@') ? `@${s}` : s
  }

  const entries = (pack) => cfg.pack_loras[pack.config_key] ?? []
  const entryOf = (pack, name) => entries(pack).find((e) => e.name === name)

  // *packs* has one entry per settings key (packs sharing a key share their LoRAs).

  // Every file shown: the ones there, then ones a pack uses that are not (moved, deleted, typed).
  let names = $derived.by(() => {
    const out = Object.keys(files)
    for (const pack of packs) for (const e of entries(pack)) if (!out.includes(e.name)) out.push(e.name)
    return out
  })

  function toggle(pack, name, on) {
    cfg.pack_loras[pack.config_key] ??= []
    const list = cfg.pack_loras[pack.config_key]
    if (on) list.push({ name, strength: 1, trigger: triggerFor(pack, name), hidden: false })
    else list.splice(list.findIndex((e) => e.name === name), 1)
  }

  function addTyped() {
    const name = typed.trim()
    if (!name || !packs.length) return
    if (!entryOf(packs[0], name)) toggle(packs[0], name, true)
    typed = ''
  }

  async function pick(e) {
    const file = e.currentTarget.files[0]
    e.currentTarget.value = ''
    if (!file) return
    error = ''
    if (files[file.name] && !confirm(`${file.name} is already uploaded. Replace it?`)) return
    try {
      await uploadLora(file, (p) => (progress = { name: file.name, ...p }), uploadBase)
      // A new file is set up for the first pack right away; the checkboxes change that.
      if (packs.length && !entryOf(packs[0], file.name)) toggle(packs[0], file.name, true)
      if (has('modal') && has('pc')) await api('POST', '/loras/sync') // copy it to the PC now
    } catch (err) {
      error = `${file.name}: ${err.message}`
    } finally {
      progress = null
      await reload(true) // also after an error: the file may have arrived regardless
    }
  }

  let deleting = $state(null) // the file being deleted, until the list shows it gone

  async function remove(name) {
    const where = listed.length > 1 ? ' from your PC and your Modal Volume' : ''
    if (!confirm(`Delete ${name}${where}? It is turned off in every model.`)) return
    error = ''
    deleting = name
    try {
      const r = await api('DELETE', `/loras/${encodeURIComponent(name)}`)
      if (r.errors?.length) error = r.errors.join(' ')
      for (const pack of packs) if (entryOf(pack, name)) toggle(pack, name, false)
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
    return { err: packs.some((pack) => entryOf(pack, name)), text: '—' }
  }

  let packNames = $derived(packs.map((p) => p.display_name).join(', '))
  let errors = $derived(Object.entries(listing?.errors ?? {}).map(([b, m]) => `${PLACE[b] ?? b}: ${m}`))
</script>

<h2>LoRAs</h2>
<p class="muted">
  For {packNames}. Tick the models a LoRA should apply to. With a trigger it applies only when the prompt contains that
  word, and Claude is told the trigger unless the LoRA is hidden; without one it always applies. Save to apply.
</p>
{#if has('modal') && has('pc')}
  <p class="muted">Uploads go to your Modal Volume and are copied to your PC.</p>
{:else if has('modal')}
  <p class="muted">Uploads go to your Modal Volume.</p>
{:else if has('pc')}
  <p class="muted">Uploads go to your PC, through this Worker.</p>
{:else if has('machine')}
  <p class="muted">Uploads go to ComfyUI's LoRAs folder on this computer.</p>
{/if}
{#if has('modal')}
  <p class="muted">A GPU that is already running picks up a new LoRA once it is idle.</p>
{/if}
{#if listing?.offline?.includes('pc')}
  <p class="muted">
    Your PC is offline: {has('modal') ? 'it gets new LoRAs when it is next online' : 'uploads need it online'}.
  </p>
{/if}

{#if !listing}
  <p class="muted">Loading…</p>
{:else if !names.length}
  <p class="muted">{listed.length ? 'None yet.' : 'None added yet.'}</p>
{/if}

{#each names as name (name)}
  <div class="file">
    <div class="row head">
      <b class="name">{name}</b>
      {#each listed as where (where)}
        {@const m = mark(name, where)}
        <span class="place" class:ok={m.ok} class:err={m.err} class:muted={!m.ok && !m.err}>{#if PLACE[where]}<b>{PLACE[where]}</b>&nbsp;{/if}{m.text}</span>
      {/each}
      {#if files[name] && listed.length}
        <button class="secondary" onclick={() => remove(name)} disabled={!!progress || deleting !== null}>
          {deleting === name ? 'Deleting…' : 'Delete'}
        </button>
      {/if}
    </div>
    {#each packs as pack (pack.config_key)}
      {@const entry = entryOf(pack, name)}
      <div class="row pack">
        <label class="use"><input type="checkbox" checked={!!entry} onchange={(e) => toggle(pack, name, e.currentTarget.checked)} /> {pack.display_name}</label>
        {#if entry}
          <input class="strength" type="number" min="-5" max="5" step="0.1" bind:value={entry.strength} aria-label="Strength" title="Strength" />
          <input class="trigger" type="text" bind:value={entry.trigger} placeholder="always on" aria-label="Trigger" title="Trigger word" />
          <label class="hidden"><input type="checkbox" bind:checked={entry.hidden} /> Hidden</label>
        {/if}
      </div>
    {/each}
  </div>
{/each}

{#if progress}
  <p>
    {progress.phase === 'upload' ? 'Uploading' : 'Saving'} {progress.name}…
    <span class="muted">{formatBytes(progress.done) || '0 MB'} of {formatBytes(progress.total)}</span>
  </p>
  <progress max={progress.total} value={progress.done}></progress>
{:else}
  {#if uploadBase}
    <label class="upload">
      <span class="button">Upload LoRA</span>
      <input type="file" accept=".safetensors" onchange={pick} />
    </label>
  {/if}
{/if}
{#if has('url')}
  <div class="row">
    <input type="text" bind:value={typed} placeholder="file.safetensors" aria-label="LoRA file name" />
    <button class="secondary" onclick={addTyped} disabled={!typed.trim()}>Add</button>
  </div>
{/if}
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
  .upload input { display: none; }
  @media (max-width: 560px) { .pack { flex-wrap: wrap; } }
</style>
