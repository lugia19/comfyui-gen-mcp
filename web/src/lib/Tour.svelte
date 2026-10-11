<script>
  import { getContext, onDestroy, onMount } from 'svelte'
  import { GUIDE, loadGuides } from './api.js'
  import { concat, next, number, prev, safe, shown, start, total } from '../../../site/guide/tour-core.js'
  import '../../../site/guide/tour.css'

  // A walkthrough from the setup site's guides.json (the same as the site's tour.js draws): the guides
  // in *ids*, walked as one. The children, the plain steps, show until it loads, and instead of it
  // when it doesn't or a screenshot is missing.
  //   mode "wizard": in a Wizard step, whose Back / Next drive it (it registers with the Wizard);
  //   mode "split": the screenshot on the left of a .wz-split page, with its own Back / Next;
  //   mode "overlay": over the whole window, with a Close (onclose).
  // *shot* (bindable): whether a screenshot is showing, for a page that lays itself out around it.
  let { ids, mode = 'split', title = '', onclose = () => {}, shot = $bindable(false), children } = $props()

  let guide = $state(null)
  let failed = $state(false)
  let pos = $state(start())
  let all = $state(false)

  const wizard = mode === 'wizard' ? getContext('wizard') : null
  const api = {
    next: () => go(next(guide, pos)),
    prev: () => go(prev(guide, pos)),
    atStart: () => !prev(guide, pos),
    atEnd: () => !next(guide, pos),
    hasShot: () => Boolean(view?.image),
  }

  onMount(() => {
    loadGuides()
      .then((g) => (guide = concat(g, Array.isArray(ids) ? ids : [ids])))
      .catch(() => {})
  })
  onDestroy(() => wizard?.unregister(api))

  let view = $derived(guide?.views[pos.v])
  let steps = $derived(guide ? shown(guide, pos) : [])
  let end = $derived(guide ? !next(guide, pos) : false)
  let live = $derived(Boolean(guide) && !failed)

  $effect(() => {
    shot = live && Boolean(view?.image)
    // The Wizard follows the walkthrough: registered while it shows, told of every move.
    if (wizard) {
      if (live) wizard.register(api, pos)
      else wizard.unregister(api)
    }
  })

  function go(to) {
    if (to) pos = to
  }

  function key(e) {
    if (e.key === 'Escape' && mode === 'overlay') onclose()
  }
</script>

<svelte:window onkeydown={mode === 'overlay' ? key : undefined} />

{#snippet stage()}
  <div class="tour-stage">
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
  </div>
{/snippet}

{#snippet text()}
  <p class="wz-count">Step {number(guide, pos)} of {total(guide)}</p>
  <ol class="tour-steps" start={steps[0].n}>
    {#each steps as s (s.n)}
      <li class={s.current ? 'current' : 'done'}>{@html safe(s.html)}</li>
    {/each}
  </ol>
  <div class="tour-nav">
    <button type="button" class="tour-prev" disabled={!prev(guide, pos)} onclick={() => go(prev(guide, pos))}>Back</button>
    <span class="tour-count">Step {number(guide, pos)} of {total(guide)}</span>
    {#if mode === 'overlay' && end}
      <button type="button" class="tour-next" onclick={onclose}>Done</button>
    {:else}
      <button type="button" class="tour-next" onclick={() => go(end ? start() : next(guide, pos))}>{end ? 'Start over' : 'Next'}</button>
    {/if}
    <button type="button" class="tour-toggle" onclick={() => (all = !all)}>{all ? 'Hide' : 'Show'} all steps</button>
  </div>
  {#if all}
    <ol class="tour-all">
      {#each guide.views.flatMap((v) => v.steps) as s}<li>{@html safe(s.html)}</li>{/each}
    </ol>
  {/if}
{/snippet}

{#if mode === 'overlay'}
  <div class="tour-pop" role="dialog" aria-modal="true" aria-label={title || 'Walkthrough'}>
    {#if live}
      {@render stage()}
      <div class="tour-side">
        <button type="button" class="secondary tour-close" onclick={onclose}>Close</button>
        {#if title}<h2>{title}</h2>{/if}
        {@render text()}
      </div>
    {:else}
      <div class="tour-side">
        <button type="button" class="secondary tour-close" onclick={onclose}>Close</button>
        {#if title}<h2>{title}</h2>{/if}
        {@render children?.()}
      </div>
    {/if}
  </div>
{:else if live}
  <div class="tour" data-guide={Array.isArray(ids) ? ids.join(' ') : ids}>
    {@render stage()}
    {@render text()}
  </div>
{:else}
  {@render children?.()}
{/if}
