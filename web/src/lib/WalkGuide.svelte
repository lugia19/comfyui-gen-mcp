<script>
  import { getContext, onDestroy, onMount } from 'svelte'
  import { loadGuides } from './api.js'
  import { concat, safe, steps } from '../../../site/guide/tour-core.js'

  // The guides in *ids* (guides.json, as on the setup site) as steps of a Walk, one per guide step,
  // their screenshots shown while they are current. The children, the plain step, show as one step
  // until the guides load, and instead of them when they don't or a screenshot is missing.
  let { ids, children } = $props()

  const walk = getContext('walk')
  const id = walk.add()
  let guide = $state.raw(null)
  let failed = $state(false)

  onMount(() => {
    loadGuides()
      .then((g) => (guide = concat(g, Array.isArray(ids) ? ids : [ids])))
      .catch(() => (failed = true))
  })
  let list = $derived(guide && !failed ? steps(guide).map((s) => ({ ...s, fail: () => (failed = true) })) : null)
  $effect(() => walk.set(id, list ?? [{}]))
  onDestroy(() => walk.drop(id))

  let first = $derived(walk.first(id))
  const cls = (i) => (i < walk.at ? 'done' : i === walk.at ? 'current' : '')
</script>

{#if list}
  {#each list as s, k (k)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <li class={cls(first + k)}><div class="walk-text" onclick={() => walk.go(first + k)}>{@html safe(s.html)}</div></li>
  {/each}
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <li class={cls(first)}><div class="walk-text" onclick={() => walk.go(first)}>{@render children?.()}</div></li>
{/if}
