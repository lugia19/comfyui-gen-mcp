<script>
  import { api, formatBytes } from './api.js'
  import { Task } from './task.svelte.js'

  // Settings → Models, under the cards: the models stored but not selected, to free their space. One
  // row per model: its size and where it is; Delete removes its files from every GPU (an offline PC
  // keeps its copy). The server picks the files, never this page: only those no selected model (or
  // the rest of its family, or the background models) uses, so a text encoder two models share
  // stays while either is selected. *saved* is the config as last saved: a new save changes what
  // may go, so the list is read again. Shown only when something is listed.
  let { saved } = $props()

  let listing = $state(null) // {gpus: [{id, name, kind}], packs: [{name, display_name, legacy, on: {gpu id: {bytes} | {state, error?}}}]}
  let notes = $state([]) // after a delete
  const loading = new Task()
  const deleting = new Task()

  const load = () => loading.run(async () => (listing = await api('GET', '/models/stored')))
  $effect(() => {
    JSON.stringify(saved) // read again after each save
    load()
  })

  const STATES = { offline: 'offline', old_agent: 'update its agent to manage this', unknown: "can't tell" }
  const bytes = (pack) => Object.values(pack.on).reduce((n, o) => n + (o.bytes ?? 0), 0)
  const where = (pack) =>
    listing.gpus
      .map((g) => ({ name: g.name, o: pack.on[g.id] }))
      .filter(({ o }) => o && (o.bytes || o.state))
      .map(({ name, o }) => (o.bytes ? `${name}: ${formatBytes(o.bytes)}` : `${name}: ${STATES[o.state] ?? o.state}${o.error ? ` (${o.error})` : ''}`))
      .join(' · ')

  function remove(pack) {
    const places = listing.gpus.filter((g) => pack.on[g.id]?.bytes).map((g) => g.name).join(', ')
    const ask =
      `Delete ${pack.display_name}'s files from ${places} (${formatBytes(bytes(pack))})? ` +
      'Files a selected model also uses stay. It downloads again if you choose it later.'
    if (!confirm(ask)) return
    notes = []
    deleting.run(async () => {
      const r = await api('POST', '/models/delete', { pack: pack.name })
      notes = [
        `${pack.display_name}: ${formatBytes(r.bytes) || 'nothing'} freed.`,
        ...r.busy.map((n) => `${n}: some files are in use by ComfyUI. Restart it (Setup), then delete again.`),
        ...r.offline.map((n) => `${n} is offline: its copy stays until you delete again with it on.`),
        ...r.errors,
      ]
      await load()
    }, pack.name)
  }
</script>

{#if listing?.packs.length || notes.length}
  <section>
    <h2>Stored models</h2>
    {#if listing.packs.length}
      <p class="muted">Models you don't have selected, still taking space. Deleting one frees it on every GPU.</p>
    {/if}
    {#each listing.packs as pack (pack.name)}
      <div class="row stored">
        <span class="name">
          <b>{pack.display_name}</b>
          {#if pack.legacy}<span class="muted">(older)</span>{/if}
          <br /><span class="muted">{where(pack)}</span>
        </span>
        <button type="button" class="secondary" disabled={Boolean(deleting.busy) || !bytes(pack)} onclick={() => remove(pack)}>
          {deleting.busy === pack.name ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    {/each}
    {#each notes as n}<p class="muted">{n}</p>{/each}
    {#if deleting.error}<p class="err">{deleting.error}</p>{/if}
  </section>
{/if}
{#if loading.error}<p class="err">Stored models: {loading.error}</p>{/if}

<style>
  .stored {
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    border-top: 1px solid var(--border);
    padding: 8px 0;
  }
  .name {
    flex: 1;
    min-width: 0;
  }
</style>
