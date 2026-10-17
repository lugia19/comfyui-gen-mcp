<script>
  import { onDestroy, onMount } from 'svelte'

  // A PC agent's "Update to vX" (design §9): on its own page's header, and on its row in the
  // Worker's GPU list. The agent asks its launcher's shim for the release now and restarts into it
  // (packages/agent/src/update.ts). An agent whose launcher predates that says can: false, and an
  // older agent has no such API: no button either way, as before.
  // *call(method, path)*: the agent's API (the page's own, or relayed through the Worker).
  // *latest*: the release to offer, when the caller knows it (the GPU list, from the Worker's own
  // check); else the agent's answer says. *label*: the button's words before the tag.
  // *onupdated*: the agent came back on the new version. *reload*: then offer reloading this page
  // (the agent's own page is served by the agent, so it is the new one only after that).
  let { version, call, latest = null, can = null, label = 'Update to', showVersion = false, reload = false, onupdated = () => {} } = $props()

  const POLL_MS = 3000
  const GIVE_UP_MS = 3 * 60_000

  let status = $state(null) // GET /update: {current, latest, newer, can, state, tag, error}
  let phase = $state('idle') // idle | starting | downloading | restarting | done | failed | lost
  let error = $state('')
  let target = $state(null)
  let from = null // the version it ran when the button was pressed (*version* follows refreshes)
  let timer = null
  let started = 0

  const offered = $derived(latest ?? (status?.newer ? status.latest : null))
  const allowed = $derived(can ?? status?.can ?? false)

  async function load() {
    try {
      status = await call('GET', '/update')
    } catch {
      status = null // an older agent (no such API), or it can't be reached: no button
    }
  }

  async function start() {
    target = offered
    from = version
    phase = 'starting'
    error = ''
    started = Date.now()
    try {
      const s = await call('POST', '/update')
      phase = s.state === 'restarting' ? 'restarting' : 'downloading'
    } catch (e) {
      phase = 'failed'
      error = e.message
      return
    }
    timer = setInterval(poll, POLL_MS)
  }

  async function poll() {
    if (Date.now() - started > GIVE_UP_MS) return stop('lost')
    let s
    try {
      s = await call('GET', '/update')
    } catch {
      phase = 'restarting' // gone while it restarts
      return
    }
    if (s.current !== from) {
      target = s.current
      stop('done')
      onupdated(s.current)
    } else if (s.state === 'failed') {
      error = s.error ?? 'The update failed.'
      stop('failed')
    } else if (s.state === 'restarting') {
      phase = 'restarting'
    }
  }

  function stop(to) {
    clearInterval(timer)
    timer = null
    phase = to
  }

  onMount(() => {
    if (latest === null || can === null) load()
  })
  onDestroy(() => clearInterval(timer))
</script>

<span class="upd">
  {#if showVersion}<span class="muted">{version}</span>{/if}
  {#if phase === 'idle' && offered && allowed}
    <button type="button" class="small" onclick={start} title="Downloads it and restarts the agent now; a generation that is running finishes first">{label} {offered}</button>
  {:else if phase === 'starting' || phase === 'downloading'}
    <button type="button" class="small secondary" disabled>Downloading {target}…</button>
  {:else if phase === 'restarting'}
    <button type="button" class="small secondary" disabled>Restarting into {target}…</button>
  {:else if phase === 'done' && reload}
    <button type="button" class="small" onclick={() => location.reload()}>Reload for {target}</button>
  {:else if phase === 'done'}
    <span class="ok">Updated to {target}</span>
  {:else if phase === 'lost'}
    <span class="err" title="It didn't come back on {target} within 3 minutes">Not back yet: check the PC</span>
  {:else if phase === 'failed'}
    <!-- Short, as the Worker's: the header has no room for the reason, which the tooltip and the agent's log have. -->
    <button type="button" class="small danger" title={error} onclick={start}>Update failed: try again</button>
  {/if}
</span>

<style>
  .danger {
    background: none;
    color: var(--err);
    border-color: var(--err);
  }
  .upd {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
</style>
