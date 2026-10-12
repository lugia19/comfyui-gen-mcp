<script>
  import { api, gpuName, platformName } from './api.js'
  import Icon from './Icon.svelte'

  // The Worker's GPUs, in priority order (design §2, "GPUs"): a call goes to the first that is
  // online, not paused and enabled, and has the model ready. Each PC pairs with its own link; Modal
  // and a ComfyUI by URL are added by their own steps (the PC step shows a new PC's download and
  // link). *gpus* is /api/state's list (with each one's live state); *refresh* reloads it.
  let { gpus, refresh } = $props()

  const KIND = { pc: 'PC', modal: 'Modal', url: 'ComfyUI by URL' }
  let busy = $state('') // the id an action is running for
  let error = $state('')
  let names = $state({}) // id -> the name being edited

  async function act(id, fn) {
    busy = id
    error = ''
    try {
      await fn()
      await refresh()
    } catch (e) {
      error = e.message
    } finally {
      busy = ''
    }
  }

  const patch = (g, changes) => act(g.id, () => api('PATCH', `/gpus/${g.id}`, changes))

  function move(i, by) {
    const ids = gpus.map((g) => g.id)
    ;[ids[i], ids[i + by]] = [ids[i + by], ids[i]]
    act(ids[i], () => api('PUT', '/gpus/order', { ids }))
  }

  function remove(g) {
    const what = g.kind === 'pc' ? 'Its agent disconnects; pair it again with a new link.' : g.kind === 'modal' ? 'The Modal app stays deployed; deploy again to add it back.' : ''
    if (confirm(`Remove ${g.name} from this Worker? ${what}`)) act(g.id, () => api('DELETE', `/gpus/${g.id}`))
  }

  function newLink(g) {
    if (confirm(`Make a new pairing link for ${g.name}? It disconnects until you paste the new link into its agent.`)) {
      act(g.id, () => api('POST', `/gpus/${g.id}/pair`))
    }
  }

  function rename(g) {
    const name = (names[g.id] ?? '').trim()
    delete names[g.id]
    if (name && name !== g.name) patch(g, { name })
  }

  function keepWarm(g, e) {
    const minutes = Number(e.currentTarget.value)
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 60 && minutes !== g.keep_warm_minutes) patch(g, { keep_warm_minutes: minutes })
  }

  const since = (t) => (t ? new Date(t).toLocaleString() : '')
  // The rename box takes the cursor, with the old name selected: on the next frame, as bind:value
  // sets the value after this runs, and setting it moves the caret to the end.
  const focused = (el) => {
    el.focus()
    requestAnimationFrame(() => el.select())
  }

  function describe(g) {
    if (!g.enabled) return { text: 'Turned off', cls: 'muted' }
    if (g.kind === 'modal') return { text: 'Runs on demand', cls: 'ok' }
    if (g.kind === 'url') return { text: g.base_url, cls: 'muted' }
    if (g.online && g.paused) return { text: 'Paused', cls: 'muted' }
    if (g.online) return { text: `Connected since ${since(g.since)}`, cls: 'ok' }
    return { text: g.seen ? 'Offline' : 'Waiting for its agent to pair', cls: 'muted' }
  }
</script>

{#snippet trash(g)}
  <button type="button" class="danger small icon-btn" disabled={busy === g.id} onclick={() => remove(g)} title="Remove {g.name}" aria-label="Remove {g.name}"><Icon name="trash" /></button>
{/snippet}

{#each gpus as g, i (g.id)}
  {@const st = describe(g)}
  <div class="gpu" class:off={!g.enabled}>
    <div class="row head">
      <span class="order">{i + 1}</span>
      {#if names[g.id] !== undefined}
        <input class="name" type="text" use:focused bind:value={names[g.id]} onblur={() => rename(g)} onkeydown={(e) => e.key === 'Enter' && rename(g)} aria-label="Name" />
      {:else}
        <button type="button" class="link name" title="Rename" onclick={() => (names[g.id] = g.name)}><b>{g.name}</b></button>
      {/if}
      <span class="muted">{KIND[g.kind]}</span>
      <span class={st.cls}>{st.text}</span>
      <span class="spacer"></span>
      <button type="button" class="secondary small" disabled={i === 0 || busy !== ''} onclick={() => move(i, -1)} aria-label="Move up">↑</button>
      <button type="button" class="secondary small" disabled={i === gpus.length - 1 || busy !== ''} onclick={() => move(i, 1)} aria-label="Move down">↓</button>
    </div>
    {#if g.kind === 'pc' && g.online && g.info}
      <p class="muted">Agent {g.info.version} on {platformName(g.info.platform)}{#if g.info.gpu}, GPU: {gpuName(g.info.gpu)}{/if}</p>
    {/if}
    <!-- Actions: pausing and the PC's page first, the disruptive ones at the far end. -->
    {#if g.kind === 'pc'}
    <div class="row actions">
      {#if g.online}
        {#if g.paused}
          <button type="button" class="ok small" disabled={busy === g.id} onclick={() => act(g.id, () => api('POST', `/gpus/${g.id}/pause`, { paused: false }))}><Icon name="play" />Resume</button>
        {:else}
          <button type="button" class="warn small" disabled={busy === g.id} onclick={() => act(g.id, () => api('POST', `/gpus/${g.id}/pause`, { paused: true }))}><Icon name="pause" />Pause</button>
        {/if}
      {/if}
      <!-- The PC's own Comfy-Gen page, through this Worker (design §9, "A page per PC"). -->
      <a class="button small" href="/gpu/{g.id}" target="_blank" rel="noopener" title="Its ComfyUI, folders and models, as on the PC"><Icon name="external" />Open its page</a>
      <span class="spacer"></span>
      <button type="button" class="danger small" disabled={busy === g.id} onclick={() => newLink(g)} title="It disconnects until the new link is pasted into its agent"><Icon name="link" />New pairing link</button>
      {@render trash(g)}
    </div>
    {/if}
    <div class="row controls">
      <label class="check" title="Unticked, no images go to this GPU"><input type="checkbox" checked={g.enabled} onchange={(e) => patch(g, { enabled: e.currentTarget.checked })} /> Enabled</label>
      {#if g.kind !== 'url'}
        <label class="check">Keep warm
          <input class="minutes" type="number" min="1" max="60" value={g.keep_warm_minutes} onchange={(e) => keepWarm(g, e)} /> min
        </label>
      {/if}
      {#if g.kind !== 'pc'}<span class="spacer"></span>{@render trash(g)}{/if}
    </div>
    {#if g.kind === 'modal'}
      <p class="muted hint">Keep warm: how long the GPU stays up after the last image. On Modal that time is billed.</p>
    {:else if g.kind === 'pc'}
      <p class="muted hint">Keep warm: how long ComfyUI keeps the model loaded after the last image.</p>
    {/if}
  </div>
{/each}
{#if gpus.length > 1}
  <p class="muted">A call goes to the first GPU that is online, not paused, and has the model ready; the others take
    over when it can't. PCs pause from their tray icon too.</p>
{/if}
{#if error}<p class="err">{error}</p>{/if}

<style>
  .gpu { border-top: 1px solid var(--border); padding: 10px 0; }
  .gpu.off { opacity: 0.6; }
  .head { gap: 6px 12px; align-items: center; }
  .order { color: var(--muted); font-variant-numeric: tabular-nums; }
  .name { min-width: 0; }
  input.name { width: 180px; margin: 0; }
  .link { background: none; border: none; padding: 0; margin: 0; color: inherit; cursor: text; }
  .spacer { flex: 1; }
  .actions { gap: 8px; align-items: center; margin-top: 8px; }
  .actions .button.small { margin-top: 0; padding: 4px 12px; }
  .icon-btn { padding: 4px 8px; }
  .controls { gap: 6px 16px; align-items: center; margin-top: 6px; }
  .check { display: flex; gap: 6px; align-items: center; margin: 0; font-weight: normal; }
  .minutes { width: 64px; margin: 0; }
  .small { margin-top: 0; padding: 4px 12px; }
  .hint { margin: 4px 0 0; font-size: 13px; }
</style>
