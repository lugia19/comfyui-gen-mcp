<script>
  import { onDestroy, onMount, untrack } from 'svelte'
  import { api } from './api.js'
  import BuildLog from './BuildLog.svelte'
  import { Task } from './task.svelte.js'

  // The Worker's version in the header, with its update button beside it (design §7): the Worker
  // checks for a release daily and updates itself; the button starts the same build now. A panel
  // under the header has the details, Update now, and the build's log while it runs. A Worker made
  // by the setup site (path "oauth") uploads the release itself: Update now answers once it's live.
  let { info, refresh } = $props()
  // The version this page was loaded from: a refresh after an update reports the new one, and the
  // page is still the old one until reloaded.
  const version = untrack(() => info.version)

  let update = $state(null) // GET /api/update: {current, latest, dev, newer, can, build, building, outcome}, or on the oauth path {…, path, lost, error}
  let oauth = $derived(update?.path === 'oauth')
  let updatedTo = $state(null) // the oauth path's update finished here
  let seen = $state(false) // this page saw an update build run: its end is shown here
  let open = $state(false)
  const starting = new Task()
  let wrap

  async function load() {
    try {
      update = await api('GET', '/update')
      if (update.building) seen = true
      if (update.build && update.build !== info.build) await refresh() // started elsewhere: the log follows info.build
    } catch {
      update = null // GitHub unreachable: say nothing
    }
  }

  const start = () =>
    starting.run(async () => {
      const r = await api('POST', '/update')
      if (r.updated) return void (updatedTo = r.updated)
      seen = true
      await load()
      await refresh()
    })

  // done: this Worker now runs another version than this page was loaded from (the build finished
  // here, or the daily one did while it was open). failed: the last update build didn't succeed.
  let phase = $derived.by(() => {
    if (!update) return null
    if (update.dev) return 'dev'
    if (updatedTo) return 'done'
    if (update.building) return 'building'
    if (update.current !== version || (seen && update.outcome === 'success')) return 'done'
    if (update.newer && (oauth ? update.error : update.outcome && update.outcome !== 'success')) return 'failed'
    if (update.newer) return 'available'
    return 'latest'
  })

  // While a build runs, check on it now and then: the log, which also notices its end, only runs
  // while the panel is open.
  let timer = null
  $effect(() => {
    if (phase !== 'building') return
    timer = setInterval(load, 20_000)
    return () => clearInterval(timer)
  })

  onMount(load)
  onDestroy(() => clearInterval(timer))

  function outside(e) {
    if (open && wrap && !wrap.contains(e.target)) open = false
  }
  function key(e) {
    if (e.key === 'Escape') open = false
  }

  const title = $derived(
    phase === 'dev'
      ? oauth
        ? "A development build: it doesn't update itself."
        : "A development build: it doesn't update itself. Remove the build's COMFY_GEN_REF variable to go back to releases."
      : phase === 'latest'
        ? 'The latest release. This Worker checks for new ones every day.'
        : '',
  )
  const notes = (v) => `https://github.com/lugia19/comfyui-gen-mcp/releases/tag/${v}`
  const modal = $derived((info.gpus ?? []).some((g) => g.kind === 'modal'))
</script>

<svelte:window onclick={outside} onkeydown={key} />

<span class="upd" bind:this={wrap}>
  <span class="muted" {title}>{version}{#if phase === 'dev'}&nbsp;(dev){/if}</span>
  {#if phase === 'available'}
    <button type="button" class="small" onclick={() => (open = !open)}>Update to {update.latest}</button>
  {:else if phase === 'building'}
    <button type="button" class="small secondary" onclick={() => (open = !open)}>Updating…</button>
  {:else if phase === 'done'}
    <button type="button" class="small" onclick={() => location.reload()}>Reload for {updatedTo ?? update.current}</button>
  {:else if phase === 'failed'}
    <button type="button" class="small danger" onclick={() => (open = !open)}>Update failed</button>
  {/if}

  {#if open && (phase === 'available' || phase === 'building' || phase === 'failed')}
    <div class="panel" role="dialog" aria-label="Update">
      {#if phase === 'building'}
        <p>Updating to <b>{update.latest}</b>. Image requests keep working meanwhile.</p>
        {#if update.build === info.build}
          {#key update.build}<BuildLog takes="2 to 5 minutes" onfinished={load} />{/key}
        {/if}
      {:else}
        {#if phase === 'failed'}
          <p class="err">The last update didn't finish ({oauth ? update.error : `Cloudflare says: ${update.outcome}`}). This Worker still runs {update.current}.</p>
        {/if}
        <p>
          This Worker runs <b>{update.current}</b>; <b>{update.latest}</b> is out.
          <a href={notes(update.latest)} target="_blank" rel="noopener">What's new</a>
        </p>
        <p class="muted">
          {#if oauth}
            It updates itself within a day. Updating now takes a few seconds; image requests keep working meanwhile.
          {:else}
            It updates itself within a day. Updating now takes 2 to 5 minutes{modal ? ' and redeploys ComfyUI on Modal too' : ''};
            image requests keep working meanwhile.
          {/if}
        </p>
        {#if update.lost}<p class="muted">Reconnect Cloudflare first, with the button at the top of the page.</p>
        {:else if !update.can}<p class="muted">Log in again with a Cloudflare token to update from here.</p>{/if}
        {#if starting.error}<p class="err">{starting.error}</p>{/if}
        <div class="row">
          <button type="button" onclick={start} disabled={!update.can || starting.busy}>{starting.busy ? (oauth ? 'Updating…' : 'Starting…') : phase === 'failed' ? 'Try again' : 'Update now'}</button>
          <button type="button" class="secondary" onclick={() => (open = false)}>Cancel</button>
        </div>
        {#if phase === 'failed' && update.build === info.build}
          <details class="guide">
            <summary>The build's log</summary>
            {#key update.build}<BuildLog onfinished={async () => {}} />{/key}
          </details>
        {/if}
      {/if}
    </div>
  {/if}
</span>

<style>
  .upd {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }
  .danger {
    background: none;
    color: var(--err);
    border-color: var(--err);
  }
  /* Under the header's right edge (the header is its positioning box): over the page, not in it. */
  .panel {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 40;
    width: min(440px, calc(100vw - 24px));
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px 16px 14px;
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.35);
    text-align: left;
  }
  .panel :global(pre) {
    max-height: 220px;
  }
  .panel :global(h2) {
    font-size: 15px;
  }
</style>
