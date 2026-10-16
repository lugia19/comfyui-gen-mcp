<script>
  import { getContext, onDestroy, setContext, untrack } from 'svelte'
  import { GUIDE } from './api.js'
  import { stageAt } from '../../../site/guide/tour-core.js'
  import '../../../site/guide/tour.css'

  // A page's steps, in one numbered list (`ol.steps`): its own (WalkStep) and walkthroughs' from
  // guides.json (WalkGuide), every one always listed. One is current (red), the screenshot shows its
  // walkthrough view, and a step's buttons and fields show only while it is current. Next walks
  // them: in a Wizard step its Back / Next (registered as the Wizard's walkthrough, which also pins
  // the screenshot on the left), elsewhere the Back / Next here. Clicking a step goes to it.
  // *shot* (bindable): whether a screenshot is showing, for a page that lays itself out around it.
  let { shot = $bindable(false), children } = $props()

  // The items come in groups (a WalkStep is one item, a WalkGuide one per guide step), in document
  // order: each group takes its place as it is created, and sets its items from an effect.
  const order = []
  let groups = $state.raw({}) // group id -> [{ view?, mark?, fail? }]
  let seq = 0
  let current = $state(0)

  let items = $derived((groups, order.flatMap((id) => groups[id] ?? [{}]))) // *order* is plain: *groups* changes with it
  let at = $derived(Math.min(current, Math.max(0, items.length - 1)))
  let stage = $derived(stageAt(items, at))

  setContext('walk', {
    add: () => {
      const id = ++seq
      order.push(id)
      return id
    },
    // Called from the items' effects: untracked, or reading what they write would loop.
    set: (id, list) => untrack(() => (groups = { ...groups, [id]: list })),
    drop: (id) =>
      untrack(() => {
        order.splice(order.indexOf(id), 1)
        const { [id]: _, ...rest } = groups
        groups = rest
      }),
    // The group's first item's index in the list.
    first: (id) => {
      let n = 0
      for (const o of order) {
        if (o === id) return n
        n += (groups[o] ?? [{}]).length
      }
      return n
    },
    get at() {
      return at
    },
    go: (i) => (current = i),
  })

  const wizard = getContext('wizard')
  const api = {
    next: () => (current = Math.min(at + 1, items.length - 1)),
    prev: () => (current = Math.max(at - 1, 0)),
    atStart: () => at === 0,
    atEnd: () => at >= items.length - 1,
    hasShot: () => Boolean(stage?.view?.image),
  }
  $effect(() => {
    shot = Boolean(stage?.view?.image)
    // The Wizard follows: told of every move (it reads the api again).
    void [at, items]
    wizard?.register(api)
  })
  onDestroy(() => wizard?.unregister(api))

  // A screenshot that doesn't load: its walkthrough falls back to its plain step.
  const failed = () => items.find((it) => it.view === stage.view)?.fail?.()
</script>

<div class="tour walk-list">
  {#if stage}
    <div class="tour-stage">
      {#if stage.view.image}
        <a class="tour-shot" href={GUIDE + stage.view.image} target="_blank" rel="noopener" title="Open full size">
          <img src={GUIDE + stage.view.image} alt={stage.view.alt} width={stage.view.size[0]} height={stage.view.size[1]} onerror={failed} />
          {#each stage.marks as m (m.n)}
            {#if m.current && m.mark.box}
              <span class="tour-box" style="left:{m.mark.box[0]}%;top:{m.mark.box[1]}%;width:{m.mark.box[2]}%;height:{m.mark.box[3]}%"></span>
            {/if}
            <span class="tour-mark {m.mark.side} {m.current ? 'current' : 'done'}" style="left:{m.mark.x}%;top:{m.mark.y}%"><span>{m.n}</span></span>
          {/each}
        </a>
      {:else}
        <div class="tour-none">Screenshot coming: {stage.view.alt}</div>
      {/if}
    </div>
  {/if}
  <ol class="steps walk">
    {@render children?.()}
  </ol>
  {#if !wizard && items.length > 1}
    <div class="tour-nav">
      <button type="button" class="tour-prev" disabled={at === 0} onclick={api.prev}>Back</button>
      <span class="tour-count">Step {at + 1} of {items.length}</span>
      <button type="button" class="tour-next" disabled={at >= items.length - 1} onclick={api.next}>Next</button>
    </div>
  {/if}
</div>
