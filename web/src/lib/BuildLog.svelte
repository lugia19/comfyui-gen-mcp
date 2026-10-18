<script>
  import { onDestroy, onMount } from 'svelte'
  import { api } from './api.js'

  // *takes*: how long the build usually takes, as the page that started it knows. *path*: where its
  // log is: an update build's (/setup/build) or Modal's deploy (a build or a Modal Sandbox). Each
  // answers {lines, cursor, done}; a build adds its {status, outcome} (a Sandbox's end shows in the
  // Worker's state instead).
  let { onfinished, takes = 'a few minutes', path = '/setup/build' } = $props()

  let lines = $state([])
  let status = $state('')
  let outcome = $state('')
  let error = $state('')
  let cursor = null
  let timer = null
  let pre

  // One request at a time: the next poll is scheduled only after this one answers.
  async function poll() {
    try {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      const b = await api('GET', `${path}${q}`)
      if (b.done === undefined) return // no build to follow
      lines = [...lines, ...(b.lines || []).map((l) => l.replace(/\n$/, ''))]
      cursor = b.cursor || cursor
      status = b.status
      outcome = b.outcome
      if (pre) queueMicrotask(() => (pre.scrollTop = pre.scrollHeight))
      if (b.done) return await onfinished()
      error = ''
    } catch (e) {
      error = e.message
    }
    timer = setTimeout(poll, 4000)
  }

  onMount(poll)
  onDestroy(() => clearTimeout(timer))
</script>

<p>
  {#if status === 'stopped'}
    {#if outcome === 'success'}<span class="ok">Finished.</span>{:else}<span class="err">It failed: the details below say why.</span>{/if}
  {:else}
    Working on it: this takes {takes}.
  {/if}
</p>
<!-- Open from the start and left to the user: a bound open was reset on every poll, closing it. -->
<details class="guide" open>
  <summary>Details</summary>
  <pre bind:this={pre}>{lines.join('\n') || '…'}</pre>
</details>
{#if error}<p class="err">{error}</p>{/if}
