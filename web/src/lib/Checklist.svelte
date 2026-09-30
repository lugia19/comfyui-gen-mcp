<script>
  // Where a machine's setup stands, above its sections: each item ticked when done, the first
  // open one with a hint of what to do below; *done* once all are ticked.
  let { items, done } = $props()
  let next = $derived(items.findIndex((i) => !i.done))
</script>

<section class="checklist">
  <ol>
    {#each items as item, i (item.title)}
      <li class:ok={item.done} class:current={i === next}>
        <span class="badge" aria-hidden="true">{item.done ? '✓' : i + 1}</span>
        <span>
          <b>{item.title}</b>
          {#if i === next && item.hint}<br /><span class="muted">{item.hint}</span>{/if}
        </span>
      </li>
    {/each}
  </ol>
  {#if next === -1}<p class="ok"><b>All set.</b> {done}</p>{/if}
</section>

<style>
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin: 6px 0;
    color: var(--muted);
  }
  li.current,
  li.ok {
    color: var(--text);
  }
  .badge {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    border: 1.5px solid var(--border);
  }
  li.current .badge {
    border-color: var(--accent);
    color: var(--accent);
  }
  li.ok .badge {
    background: var(--ok);
    border-color: var(--ok);
    color: var(--panel);
  }
</style>
