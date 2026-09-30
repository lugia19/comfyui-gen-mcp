<script>
  import { api, formatBytes } from './api.js'
  import { uploadLora } from './upload.js'

  // One place for LoRAs: each file, with its setup per pack beside it. *cfg* is the page's working
  // config (its pack_loras is edited in place and saved with the page). *packs* are the packs that
  // take LoRAs. *where* says where the files are:
  //   modal    the Modal Volume: upload and delete here
  //   machine  this computer (the Claude Desktop extension): its LoRA folders, opened from here
  //   pc       the paired PC: listed through the agent; files go in its LoRA folder
  //   url      a ComfyUI reached by URL: no listing, a file is added by name
  // *files* is {name: size}, null while loading; *reload* refreshes it.
  let { cfg, packs, where, files, reload, error: listError = '' } = $props()

  let progress = $state(null) // {name, phase, done, total} while an upload runs
  let error = $state('')
  let typed = $state('')

  const stem = (name) => (name || '').replace(/\.safetensors$/i, '')

  // Anima's artist styles are @tags, and so are the triggers of style LoRAs made for it.
  const triggerFor = (pack, name) => {
    const s = stem(name)
    return pack.default_artist_list?.trim().startsWith('@') && !s.startsWith('@') ? `@${s}` : s
  }

  const entries = (pack) => cfg.pack_loras[pack.config_key] ?? []
  const entryOf = (pack, name) => entries(pack).find((e) => e.name === name)

  // *packs* has one entry per settings key (packs sharing a key share their LoRAs).

  // Every file shown: the ones there, then ones a pack uses that are not (moved, deleted, typed).
  let names = $derived.by(() => {
    const out = Object.keys(files || {})
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
    if (files && file.name in files && !confirm(`${file.name} is already uploaded. Replace it?`)) return
    try {
      await uploadLora(file, (p) => (progress = { name: file.name, ...p }))
      // A new file is set up for the first pack right away; the checkboxes change that.
      if (packs.length && !entryOf(packs[0], file.name)) toggle(packs[0], file.name, true)
    } catch (err) {
      error = `${file.name}: ${err.message}`
    } finally {
      progress = null
      await reload() // also after an error: the file may have arrived regardless
    }
  }

  async function remove(name) {
    if (!confirm(`Delete ${name} from your Modal Volume?`)) return
    error = ''
    try {
      await api('DELETE', `/loras/${encodeURIComponent(name)}`)
      for (const pack of packs) if (entryOf(pack, name)) toggle(pack, name, false)
      await reload()
    } catch (err) {
      error = err.message
    }
  }

  let packNames = $derived(packs.map((p) => p.display_name).join(', '))
</script>

<h2>LoRAs</h2>
<p class="muted">
  For {packNames}. Tick the models a LoRA should apply to. With a trigger it applies only when the prompt contains that
  word, and Claude is told the trigger unless the LoRA is hidden; without one it always applies. Save to apply.
</p>
{#if where === 'modal'}
  <p class="muted">Files live on your Modal Volume. A GPU that is already running picks up a new one once it is idle.</p>
{:else if where === 'machine'}
  <p class="muted">.safetensors files in ComfyUI's LoRAs folder, or in a shared models folder.</p>
{:else if where === 'pc'}
  <p class="muted">.safetensors files in your PC's LoRA folders: open them from the agent's page on the PC, then Refresh.</p>
{/if}

{#if where !== 'url' && files === null}
  <p class="muted">Loading…</p>
{:else if !names.length}
  <p class="muted">{where === 'modal' ? 'None uploaded yet.' : where === 'url' ? 'None added yet.' : 'None found yet.'}</p>
{/if}

{#each names as name (name)}
  {@const there = where === 'url' || (files && name in files)}
  <div class="file">
    <div class="row head">
      <b class="name">{name}</b>
      {#if files && name in files}<span class="muted">{formatBytes(files[name])}</span>{/if}
      {#if !there}<span class="err">{where === 'modal' ? 'not uploaded' : 'not found'}</span>{/if}
      {#if where === 'modal' && there}
        <button class="secondary" onclick={() => remove(name)} disabled={!!progress}>Delete</button>
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

{#if where === 'modal'}
  {#if progress}
    <p>
      {progress.phase === 'upload' ? 'Uploading' : 'Saving'} {progress.name}…
      <span class="muted">{formatBytes(progress.done) || '0 MB'} of {formatBytes(progress.total)}</span>
    </p>
    <progress max={progress.total} value={progress.done}></progress>
  {:else}
    <label class="upload">
      <span class="button">Upload LoRA</span>
      <input type="file" accept=".safetensors" onchange={pick} />
    </label>
  {/if}
{:else if where === 'machine'}
  <div class="row">
    <button class="secondary" onclick={() => api('POST', '/open', { which: 'loras' })}>Open LoRAs folder</button>
    <button class="secondary" onclick={reload}>Refresh</button>
  </div>
{:else if where === 'pc'}
  <button class="secondary" onclick={reload}>Refresh</button>
{:else}
  <div class="row">
    <input type="text" bind:value={typed} placeholder="file.safetensors" aria-label="LoRA file name" />
    <button class="secondary" onclick={addTyped} disabled={!typed.trim()}>Add</button>
  </div>
{/if}
{#if error || listError}<p class="err">{error || listError}</p>{/if}

<style>
  .file { border-top: 1px solid var(--border); padding: 8px 0; }
  .head { justify-content: space-between; }
  .head button { margin-top: 0; }
  .name { flex: 1; overflow-wrap: anywhere; }
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
