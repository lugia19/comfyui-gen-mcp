<script>
  import { getContext, onDestroy } from 'svelte'

  // One of the page's own steps in a Walk: *children* is its text, always shown; *controls* (its
  // buttons and fields) only while it is the current step.
  let { children, controls } = $props()

  const walk = getContext('walk')
  const id = walk.add()
  $effect(() => walk.set(id, [{}]))
  onDestroy(() => walk.drop(id))

  let i = $derived(walk.first(id))
</script>

<li class={i < walk.at ? 'done' : i === walk.at ? 'current' : ''}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="walk-text" onclick={() => walk.go(i)}>{@render children?.()}</div>
  {#if i === walk.at && controls}<div class="walk-controls">{@render controls()}</div>{/if}
</li>
