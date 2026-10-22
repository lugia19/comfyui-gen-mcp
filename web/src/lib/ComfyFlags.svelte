<script>
  import { onMount, untrack } from 'svelte'
  import { checkComfyArgs, joinArgs, splitArgs } from '../../../packages/core/src/comfy-args.ts'
  import { Task } from './task.svelte.js'

  // A GPU's own ComfyUI flags (core comfy-args.ts): typed as one line, as in a terminal, kept as a
  // list. Under the line, the arguments ComfyUI will get, one box each, so a path split by a missing
  // quote shows before it is saved. *value*: the saved list; *save(list)*: stores it (its answer's
  // warnings show); *status()*, Modal only: {error} when ComfyUI last had to start without them.
  let { value = [], save, status = null } = $props()

  const task = new Task()
  let text = $state(untrack(() => joinArgs(value)))
  let saved = $state(untrack(() => JSON.stringify(value)))
  let note = $state('')
  let startError = $state(null)
  const parsed = $derived(splitArgs(text))
  const args = $derived(parsed.args ?? [])
  const problem = $derived(parsed.error ?? checkComfyArgs(args))

  onMount(async () => {
    if (!status || !value.length) return
    try {
      const s = await status()
      // Only for these flags: a change since then gets its own try.
      if (s.error && JSON.stringify(s.error.args) === JSON.stringify(value)) startError = s.error
    } catch {
      // Modal's admin app not answering: nothing to show
    }
  })

  function commit() {
    if (problem || task.busy || JSON.stringify(args) === saved) return // Enter, then the blur: once
    note = ''
    task.run(async () => {
      const r = await save(args)
      saved = JSON.stringify(args)
      startError = null
      note = ['Saved.', ...(r?.warnings || [])].join(' ')
    })
  }
</script>

<div class="flags">
  <label>ComfyUI flags
    <input type="text" bind:value={text} onchange={commit} onkeydown={(e) => e.key === 'Enter' && commit()}
      placeholder="--reserve-vram 2" spellcheck="false" autocomplete="off" />
  </label>
  {#if args.length}
    <div class="args" aria-label="What ComfyUI gets">
      <span class="muted">ComfyUI gets:</span>
      {#each args as a, i (i)}<code>{a}</code>{/each}
    </div>
  {/if}
  {#if problem}<p class="err">{problem}</p>{/if}
  {#if task.error}<p class="err">{task.error}</p>{/if}
  {#if note}<p class="ok">{note}</p>{/if}
  {#if startError}
    <p class="err">ComfyUI wouldn't start with these flags, so it runs without them. The end of its output:</p>
    <pre>{startError.output}</pre>
  {/if}
  <p class="muted hint">
    Extra command-line flags for ComfyUI, after Comfy-Gen's own, for example <code>--lowvram</code> or
    <code>--reserve-vram 2</code>. Put quotes around a value with spaces. They apply from the next image.
  </p>
</div>

<style>
  .flags { margin-top: 8px; }
  .flags label { display: block; }
  .flags input { width: 100%; margin: 4px 0 0; font-family: var(--mono, monospace); }
  .args { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; margin-top: 6px; }
  .args code { padding: 1px 6px; border: 1px solid var(--border); border-radius: 4px; white-space: pre; }
  .hint { margin: 4px 0 0; font-size: 13px; }
  pre { white-space: pre-wrap; max-height: 12em; overflow: auto; }
</style>
