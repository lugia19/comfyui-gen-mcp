<script>
  import { api, formatBytes } from './api.js'
  import { uploadLora } from './upload.js'

  // The LoRA files on the Modal Volume: upload and delete. *files* is {name: size} or null while
  // loading; *reload* refreshes it (the LoRA rows above share it).
  let { files, reload } = $props()

  let progress = $state(null) // {name, phase, done, total} while an upload runs
  let error = $state('')

  async function pick(e) {
    const file = e.currentTarget.files[0]
    e.currentTarget.value = ''
    if (!file) return
    error = ''
    if (files && file.name in files && !confirm(`${file.name} is already uploaded. Replace it?`)) return
    try {
      await uploadLora(file, (p) => (progress = { name: file.name, ...p }))
      await reload()
    } catch (err) {
      error = `${file.name}: ${err.message}`
    } finally {
      progress = null
    }
  }

  async function remove(name) {
    if (!confirm(`Delete ${name} from your GPU?`)) return
    error = ''
    try {
      await api('DELETE', `/loras/${encodeURIComponent(name)}`)
      await reload()
    } catch (err) {
      error = err.message
    }
  }
</script>

<h2>LoRA files</h2>
<p class="muted">
  LoRAs for the Anima models, uploaded to your Modal Volume (.safetensors). A GPU that is already running
  picks up a new file once it is idle.
</p>
{#if files === null}
  <p class="muted">Loading…</p>
{:else if !Object.keys(files).length}
  <p class="muted">None uploaded yet.</p>
{:else}
  {#each Object.entries(files) as [name, size] (name)}
    <div class="row file">
      <span class="name">{name}</span>
      <span class="muted">{formatBytes(size)}</span>
      <button class="secondary" onclick={() => remove(name)} disabled={!!progress}>Delete</button>
    </div>
  {/each}
{/if}

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
{#if error}<p class="err">{error}</p>{/if}

<style>
  .file { justify-content: space-between; margin: 4px 0; }
  .file button { margin-top: 0; }
  .name { flex: 1; overflow-wrap: anywhere; }
  progress { width: 100%; }
  .upload { display: inline-block; margin-top: 10px; font-weight: normal; }
  .upload input { display: none; }
</style>
