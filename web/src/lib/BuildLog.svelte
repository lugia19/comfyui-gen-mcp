<script>
  import { onDestroy, onMount } from 'svelte'
  import { api } from './api.js'

  let { onfinished } = $props()

  let lines = $state([])
  let status = $state('')
  let outcome = $state('')
  let error = $state('')
  let cursor = null
  let timer = null
  let pre

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
      if (b.status === 'stopped') {
        clearInterval(timer)
        await onfinished()
      }
    } catch (e) {
      error = e.message
    }
  }

  onMount(() => {
    poll()
    timer = setInterval(poll, 4000)
  })
  onDestroy(() => clearInterval(timer))
</script>

<h2>Deploy log</h2>
<p class="muted">
  {#if status === 'stopped'}
    {#if outcome === 'success'}<span class="ok">Finished.</span>{:else}<span class="err">Build {outcome}.</span>{/if}
  {:else}
    Building… this takes 2 to 5 minutes.
  {/if}
</p>
<pre bind:this={pre}>{lines.join('\n') || '…'}</pre>
{#if error}<p class="err">{error}</p>{/if}
