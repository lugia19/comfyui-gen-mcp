<script>
  // The custom workflow: a ComfyUI workflow in API format, backing the generate_custom_image tool.
  // *value* is {workflow, prompt_node_title} or null; *onchange* gets the new value.
  let { value, onchange } = $props()
  let error = $state('')

  async function load(e) {
    const file = e.currentTarget.files[0]
    e.currentTarget.value = ''
    if (!file) return
    error = ''
    let wf
    try {
      wf = JSON.parse(await file.text())
    } catch {
      error = `${file.name} is not JSON.`
      return
    }
    if (!wf || typeof wf !== 'object' || Array.isArray(wf) || 'nodes' in wf || !Object.values(wf).every((n) => n && n.class_type)) {
      error = 'That is not an API-format workflow. In ComfyUI, use Workflow → Export (API).'
      return
    }
    onchange({ workflow: wf, prompt_node_title: value?.prompt_node_title || '' })
  }

  const titles = $derived(
    value ? Object.values(value.workflow).map((n) => n._meta?.title).filter(Boolean) : [],
  )
</script>

<h2>Custom workflow</h2>
<p class="muted">
  A ComfyUI workflow exported in API format. When set, Claude gets a generate_custom_image tool that runs it
  with its prompt. It can use any models and nodes this ComfyUI has.
</p>
{#if value}
  <p class="ok">A workflow with {Object.keys(value.workflow).length} nodes is set.</p>
  <label for="pn">Prompt node title</label>
  <input
    id="pn"
    type="text"
    list="pn-titles"
    value={value.prompt_node_title || ''}
    placeholder="empty: the first KSampler's positive prompt"
    oninput={(e) => onchange({ ...value, prompt_node_title: e.currentTarget.value })}
  />
  <datalist id="pn-titles">{#each titles as t (t)}<option value={t}></option>{/each}</datalist>
  <p class="muted">The node (by its title) whose <code>text</code> gets the prompt.</p>
{/if}
<div class="row">
  <label class="upload">
    <span class="button">{value ? 'Replace workflow' : 'Load workflow (.json)'}</span>
    <input type="file" accept=".json,application/json" onchange={load} />
  </label>
  {#if value}<button class="secondary" onclick={() => onchange(null)}>Remove</button>{/if}
</div>
{#if error}<p class="err">{error}</p>{/if}

<style>
  .upload { display: inline-block; margin: 0; font-weight: normal; }
  .upload input { display: none; }
</style>
