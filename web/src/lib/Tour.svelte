<script>
  import { onMount } from 'svelte'
  import { GUIDE, loadGuides } from './api.js'
  import { next, number, prev, safe, shown, start, total } from '../../../site/guide/tour-core.js'
  import '../../../site/guide/tour.css'

  // A walkthrough from the setup site's guides.json (the same as the site's tour.js draws). The
  // children, the plain steps, show until it loads, and instead of it when it doesn't or a
  // screenshot is missing.
  let { id, children } = $props()

  let guide = $state(null)
  let failed = $state(false)
  let pos = $state(start())
  let all = $state(false)
  let el = $state()

  onMount(() => {
    loadGuides()
      .then((g) => (guide = g[id] ?? null))
      .catch(() => {})
  })

  let view = $derived(guide?.views[pos.v])
  let steps = $derived(guide ? shown(guide, pos) : [])
  let end = $derived(guide ? !next(guide, pos) : false)

  function go(to) {
    if (to) pos = to
  }

  function key(e) {
    if (e.target !== el) return
    if (e.key === 'ArrowRight') go(next(guide, pos))
    else if (e.key === 'ArrowLeft') go(prev(guide, pos))
    else return
    e.preventDefault()
  }
</script>

{#if guide && !failed}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
  <div class="tour" data-guide={id} tabindex="0" role="group" aria-label="Walkthrough" bind:this={el} onkeydown={key}>
    {#if view.image}
      <a class="tour-shot" href={GUIDE + view.image} target="_blank" rel="noopener" title="Open full size">
        <img src={GUIDE + view.image} alt={view.alt} width={view.size[0]} height={view.size[1]} onerror={() => (failed = true)} />
        {#each steps as s (s.n)}
          {#if s.mark}
            {#if s.current && s.mark.box}
              <span class="tour-box" style="left:{s.mark.box[0]}%;top:{s.mark.box[1]}%;width:{s.mark.box[2]}%;height:{s.mark.box[3]}%"></span>
            {/if}
            <span class="tour-mark {s.mark.side} {s.current ? 'current' : 'done'}" style="left:{s.mark.x}%;top:{s.mark.y}%"><span>{s.n}</span></span>
          {/if}
        {/each}
      </a>
    {:else}
      <div class="tour-none">Screenshot coming: {view.alt}</div>
    {/if}
    <ol class="tour-steps" start={steps[0].n}>
      {#each steps as s (s.n)}
        <li class={s.current ? 'current' : 'done'}>{@html safe(s.html)}</li>
      {/each}
    </ol>
    <div class="tour-nav">
      <button type="button" class="tour-prev" disabled={!prev(guide, pos)} onclick={() => go(prev(guide, pos))}>Back</button>
      <span class="tour-count">Step {number(guide, pos)} of {total(guide)}</span>
      <button type="button" class="tour-next" onclick={() => go(end ? start() : next(guide, pos))}>{end ? 'Start over' : 'Next'}</button>
      <button type="button" class="tour-toggle" onclick={() => (all = !all)}>{all ? 'Hide' : 'Show'} all steps</button>
    </div>
    {#if all}
      <ol class="tour-all">
        {#each guide.views.flatMap((v) => v.steps) as s}<li>{@html safe(s.html)}</li>{/each}
      </ol>
    {/if}
  </div>
{:else}
  {@render children?.()}
{/if}
