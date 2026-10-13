<script>
  import { LABEL, percent } from './models.svelte.js'

  // One pack's download state on one GPU, for the Setup page's model rows and the Settings model
  // cards alike: the label (with its progress), and Retry or Download where one can start it.
  // *s*: that status; *status*: the page's ModelStatus; *pack*: the pack's name; *where*: the GPU.
  let { s, status, pack, where } = $props()
</script>

<span class:ok={s.state === 'done'} class:err={s.state === 'failed'} class:muted={s.state !== 'done' && s.state !== 'failed'}>
  {s.state === 'done' ? '✓ ' : ''}{LABEL[s.state] || s.state}{s.state === 'downloading' ? percent(s) : ''}
</span>
{#if s.state === 'failed' || s.state === 'missing'}
  <button type="button" class="secondary small" onclick={() => status.seed(pack, where)}>{s.state === 'failed' ? 'Retry' : 'Download'}</button>
{/if}
