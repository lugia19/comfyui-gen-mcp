<script>
  // One step of a setup page. *status*: "current" (open), "done" (ticked and folded to its summary;
  // Show opens it again), "todo" (waiting on an earlier step: the title only). The content stays
  // mounted while folded, so a step can keep reporting (downloads, connections).
  let { n, title, status, summary = '', children } = $props()
  let open = $state(false)
  let shown = $derived(status === 'current' || (status === 'done' && open))
</script>

<section class="step {status}">
  <div class="head">
    <span class="badge" aria-hidden="true">{status === 'done' ? '✓' : n}</span>
    <h2>{title}</h2>
    {#if status === 'done'}
      <span class="summary muted">{summary}</span>
      <button type="button" class="link" onclick={() => (open = !open)}>{open ? 'Hide' : 'Show'}</button>
    {/if}
  </div>
  <div class="body" hidden={!shown}>{@render children?.()}</div>
</section>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .head h2 {
    margin: 0;
  }
  .badge {
    flex: none;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 14px;
    border: 1.5px solid var(--border);
    color: var(--muted);
  }
  .current .badge {
    border-color: var(--accent);
    color: var(--accent);
  }
  .done .badge {
    background: var(--ok);
    border-color: var(--ok);
    color: var(--panel);
  }
  .todo {
    opacity: 0.6;
  }
  .summary {
    flex: 1 1 160px;
  }
  button.link {
    margin: 0 0 0 auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
  }
  .body {
    margin-top: 10px;
  }
</style>
