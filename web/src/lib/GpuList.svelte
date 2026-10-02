<script>
  import { api, gpuName, platformName } from './api.js'
  import PcManage from './PcManage.svelte'

  // The Worker's GPUs, in priority order (design §2, "GPUs"): a call goes to the first that is
  // online, not paused and enabled, and has the model ready. Each PC pairs with its own link; Modal
  // and a ComfyUI by URL are added by their own steps. *gpus* is /api/state's list (with each one's
  // live state); *refresh* reloads it.
  let { gpus, refresh } = $props()

  const RELEASE = 'https://github.com/lugia19/comfyui-gen-mcp/releases/latest/download/'
  const KIND = { pc: 'PC', modal: 'Modal', url: 'ComfyUI by URL' }
  let busy = $state('') // the id an action is running for
  let error = $state('')
  let copied = $state('')
  let names = $state({}) // id -> the name being edited
  let managing = $state({}) // id -> its ComfyUI section is open

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

  async function copy(g) {
    await navigator.clipboard.writeText(g.link)
    copied = g.id
    setTimeout(() => (copied = ''), 1500)
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

{#if !gpus.length}
  <p class="muted">No GPU yet: add one below.</p>
{/if}
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
    <div class="row controls">
      <label class="check"><input type="checkbox" checked={g.enabled} onchange={(e) => patch(g, { enabled: e.currentTarget.checked })} /> Enabled</label>
      {#if g.kind !== 'url'}
        <label class="check">Keep warm
          <input class="minutes" type="number" min="1" max="60" value={g.keep_warm_minutes} onchange={(e) => keepWarm(g, e)} /> min
        </label>
      {/if}
      {#if g.kind === 'pc' && g.online}
        <button type="button" class="secondary small" disabled={busy === g.id} onclick={() => act(g.id, () => api('POST', `/gpus/${g.id}/pause`, { paused: !g.paused }))}>
          {g.paused ? 'Resume' : 'Pause'}
        </button>
      {/if}
      {#if g.kind === 'pc' && g.online}
        <button type="button" class="secondary small" onclick={() => (managing[g.id] = !managing[g.id])}>{managing[g.id] ? 'Hide ComfyUI' : 'Manage ComfyUI'}</button>
      {/if}
      {#if g.kind === 'pc'}
        <button type="button" class="secondary small" disabled={busy === g.id} onclick={() => newLink(g)}>New pairing link</button>
      {/if}
      <button type="button" class="secondary small" disabled={busy === g.id} onclick={() => remove(g)}>Remove</button>
    </div>
    {#if g.kind === 'modal'}
      <p class="muted hint">Keep warm: how long the GPU stays up after the last image. On Modal that time is billed.</p>
    {:else if g.kind === 'pc'}
      <p class="muted hint">Keep warm: how long ComfyUI keeps the model loaded after the last image.</p>
    {/if}
    {#if g.kind === 'pc' && g.online && managing[g.id]}<PcManage id={g.id} />{/if}
    {#if g.kind === 'pc' && !g.seen}
      <ol>
        <li>
          On that PC, download the agent:
          <a href="{RELEASE}comfy-gen-agent-windows.exe">Windows</a>,
          <a href="{RELEASE}comfy-gen-agent-macos.zip">macOS (Apple silicon)</a> or
          <a href="{RELEASE}comfy-gen-agent-linux">Linux</a>, and run it. It is not signed yet: on Windows choose
          <b>More info → Run anyway</b>; on macOS unzip it, right-click it and choose <b>Open</b>; on Linux,
          <code>chmod +x</code> it first.
        </li>
        <li>Its page opens in your browser. Paste this pairing link there:</li>
      </ol>
      <div class="row"><code>{g.link}</code></div>
      <div class="row"><button type="button" onclick={() => copy(g)}>{copied === g.id ? 'Copied' : 'Copy link'}</button></div>
      <p class="muted">The link lets a PC generate for this Worker. Treat it like a password. On the agent's page, install
        ComfyUI next: it finds the models of ComfyUI installs you already have.</p>
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
  .controls { gap: 6px 16px; align-items: center; margin-top: 6px; }
  .check { display: flex; gap: 6px; align-items: center; margin: 0; font-weight: normal; }
  .minutes { width: 64px; margin: 0; }
  .small { margin-top: 0; padding: 4px 12px; }
  .hint { margin: 4px 0 0; font-size: 13px; }
  code { overflow-wrap: anywhere; }
</style>
