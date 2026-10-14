<script>
  import { onDestroy, onMount } from 'svelte'
  import { api } from './api.js'

  // *takes*: how long the build usually takes, as the page that started it knows.
  let { onfinished, takes = 'a few minutes' } = $props()

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
      const b = await api('GET', `/setup/build${q}`)
      if (!b.build) return
      lines = [...lines, ...(b.lines || [])]
      cursor = b.cursor || cursor
      status = b.status
      outcome = b.outcome
      if (pre) queueMicrotask(() => (pre.scrollTop = pre.scrollHeight))
      if (b.status === 'stopped') return await onfinished()
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
<details class="guide" open={status === 'stopped' && outcome !== 'success'}>
  <summary>Details</summary>
  <pre bind:this={pre}>{lines.join('\n') || '…'}</pre>
</details>
{#if error}<p class="err">{error}</p>{/if}
