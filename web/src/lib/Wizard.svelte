<script>
  import { setContext, untrack } from 'svelte'
  import '../../../site/guide/wizard.css'

  // The Worker's setup as a wizard (wizard.css, as on the setup site): a bar of the steps, then one
  // step filling the window. *steps*: [{ id, title, short, done, canLeave, waiting }], where
  // *waiting* says what a step that can't be left yet waits for. *current* (bindable): the step
  // shown. The children render the current step's content; a walkthrough in it (Tour mode "wizard")
  // puts its screenshot on the left and is driven by Back / Next here. Next leaves a step only once
  // it is done: its state is the proof. A step that turns done while it shows moves on by itself.
  // Moving on passes over steps marked *skip* (nothing to do there: already done, or optional); Back
  // and the bar still open them. *end* ({ label, onclick }, optional): the last step's button, where
  // Next would be.
  let { steps, current = $bindable(), end = null, children } = $props()

  let tour = $state.raw(null) // the current step's walkthrough, while it shows (raw: unregister compares it)
  let moved = $state(0) // bumped on every walkthrough move, so the buttons follow
  // Called from the walkthrough's effects: untracked, or reading what they write would loop.
  setContext('wizard', {
    register(api) {
      untrack(() => {
        tour = api
        moved++
      })
    },
    unregister(api) {
      untrack(() => {
        if (tour === api) tour = null
      })
    },
  })

  let at = $derived(Math.max(0, steps.findIndex((s) => s.id === current)))
  let step = $derived(steps[at])
  // Where Next goes: the first later step with something to do, else the last one.
  let nextStep = $derived.by(() => {
    const later = steps.slice(at + 1)
    return later.find((s) => !s.skip) ?? later.at(-1)
  })
  // The bar opens any step up to the first that can't be left yet (as Next would reach it).
  let reach = $derived.by(() => {
    const i = steps.findIndex((s) => !s.canLeave)
    return i < 0 ? steps.length - 1 : i
  })
  let walking = $derived((moved, tour !== null && !tour.atEnd()))
  let split = $derived((moved, tour !== null && tour.hasShot()))
  let canBack = $derived((moved, at > 0 || (tour !== null && !tour.atStart())))
  // Next leaves a step once it is done, or earlier where the step allows (*canLeave*).
  let leave = $derived(step.canLeave)

  let barH = $state(0)

  // A step whose state turns done while it shows (storage on, a PC paired, Modal deployed, Claude
  // connected) says so for a moment, then moves on. Only the change counts: arriving with Back at a
  // done step stays there.
  let justDone = $state(null)
  const wasDone = new Map()
  $effect(() => {
    for (const s of steps) {
      const before = wasDone.get(s.id)
      wasDone.set(s.id, s.done)
      if (before !== false || !s.done || s.id !== untrack(() => current)) continue
      justDone = s.id
      setTimeout(() => {
        if (justDone !== s.id) return
        justDone = null
        if (current === s.id && nextStep) go(nextStep.id)
      }, 1200)
    }
  })

  function go(id) {
    if (id === current) return
    tour = null
    current = id
    window.scrollTo(0, 0)
  }

  function forward() {
    if (walking) return tour.next()
    if (leave && nextStep) go(nextStep.id)
  }

  function backward() {
    if (tour && !tour.atStart()) return tour.prev()
    if (at > 0) go(steps[at - 1].id)
  }

  function key(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
    if (e.key === 'ArrowRight' && (walking || (leave && nextStep))) {
      e.preventDefault()
      forward()
    } else if (e.key === 'ArrowLeft' && canBack) {
      e.preventDefault()
      backward()
    }
  }
</script>

<svelte:window onkeydown={key} />

<div class="wz" style="--wz-top: calc(var(--app-top, 0px) + {barH}px)">
  <div class="wz-bar" bind:offsetHeight={barH}>
    <ol class="wz-progress">
      {#each steps as s, i (s.id)}
        <li>
          <button
            type="button"
            class:current={s.id === current}
            class:done={s.done && s.id !== current}
            disabled={i > Math.max(reach, at)}
            title={s.title}
            onclick={() => go(s.id)}
          >
            <span class="dot">{s.done && s.id !== current ? '✓' : i + 1}</span><span class="label">{s.short}</span>
          </button>
        </li>
      {/each}
    </ol>
  </div>

  <section class="wz-step" class:wz-split={split}>
    <h2 class="wz-title">{step.title}</h2>
    {#if justDone === step.id}<p class="ok wz-done"><b>✓ Done.</b> On to the next step…</p>{/if}
    {@render children?.()}
    {#if nextStep || at > 0 || end}
      <div class="wz-nav">
        <button type="button" class="wz-back" disabled={!canBack} onclick={backward}>Back</button>
        {#if walking}
          <button type="button" class="wz-next" onclick={forward}>Next</button>
        {:else if nextStep}
          <button type="button" class="wz-next" disabled={!leave} onclick={forward}>Next: {nextStep.title}</button>
          {#if !leave && step.waiting}<p class="wz-why">{step.waiting}</p>{/if}
        {:else if end}
          <button type="button" class="wz-next" onclick={end.onclick}>{end.label}</button>
        {/if}
      </div>
    {/if}
  </section>
</div>

<style>
  .wz-step {
    background: none;
    border: 0;
    border-radius: 0;
    margin-top: 0;
    margin-bottom: 0;
  }
</style>
