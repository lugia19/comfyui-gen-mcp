<script>
  import { onDestroy, onMount } from 'svelte'
  import { api } from './api.js'
  import OpenButton from './OpenButton.svelte'
  import Walk from './Walk.svelte'
  import WalkStep from './WalkStep.svelte'
  import { Copy, Task } from './task.svelte.js'

  // Pairing a PC that was added and hasn't connected yet (*pc*: a GPU of kind "pc" with its link):
  // the agent's download, Pair with the agent, Install ComfyUI. Setup's PC step and Settings → GPUs
  // both show it. *another*: other PCs exist (the wording says "the new PC"). Checks every 5 s
  // (*refresh*) until the agent connects, when the GPU list shows the PC instead.
  let { pc, refresh, another = false } = $props()

  const RELEASE = 'https://github.com/lugia19/comfyui-gen-mcp/releases/latest/download/'
  const AGENT_PAGE = 'http://127.0.0.1:9248/' // the agent's own page on its PC (agent config.ts DEFAULT_AGENT_PORT)

  // The agent for this browser's system first; what each needs to run an app that isn't signed yet.
  const AGENTS = [
    { os: 'windows', label: 'Windows', file: 'comfy-gen-agent-windows.exe',
      run: 'Windows may say that it protected your PC. If it does, click More info. Then click Run anyway.' },
    { os: 'mac', label: 'macOS (Apple silicon)', file: 'comfy-gen-agent-macos.zip',
      run: 'Unzip it and open it. The first time, macOS blocks it. Click Done. Open System Settings → Privacy & Security. Click Open Anyway. Then click Open Anyway again.' },
    { os: 'linux', label: 'Linux', file: 'comfy-gen-agent-linux',
      run: 'Make it executable with chmod +x comfy-gen-agent-linux. Then run it.' },
  ]
  const ua = navigator.userAgent
  const thisOs = /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'mac' : /Linux|X11/.test(ua) ? 'linux' : 'windows'
  let agentOs = $state(thisOs)
  let agent = $derived(AGENTS.find((a) => a.os === agentOs))

  const linkCopy = new Copy()
  const removing = new Task()
  function remove() {
    if (confirm(`Remove ${pc.name}? Its pairing link stops working.`)) removing.run(async () => (await api('DELETE', `/gpus/${pc.id}`), await refresh()))
  }

  let timer = null
  onMount(() => (timer = setInterval(() => refresh().catch(() => {}), 5000)))
  onDestroy(() => clearInterval(timer))
</script>

<Walk>
  <WalkStep>
    On {another ? 'the new PC' : 'the PC with the graphics card'}, download the Comfy-Gen agent. Then open it.
    {#snippet controls()}
      <div class="row">
        <a class="button" href="{RELEASE}{agent.file}">Download for {agent.label}</a>
        {#each AGENTS.filter((a) => a.os !== agentOs) as other (other.os)}
          <button type="button" class="link" onclick={() => (agentOs = other.os)}>{other.label}</button>
        {/each}
      </div>
      <p>{agent.run}</p>
    {/snippet}
  </WalkStep>
  <WalkStep>
    On that PC, click <b>Pair with the agent</b>. The agent's page opens and pairs with this Worker. (If that PC is paired
    with another Worker, the agent's page asks first.)
    {#snippet controls()}
      <!-- The link rides in the address's #fragment: it stays in the browser. The agent asks before replacing a pairing. -->
      <OpenButton href="{AGENT_PAGE}#pair={encodeURIComponent(pc.link)}" label="Pair with the agent" />
      <details class="guide">
        <summary>This page is open on another computer</summary>
        <p>Copy the pairing link. On the PC, paste it into <b>Pairing link</b> on the agent's page.</p>
        <div class="row"><code>{pc.link}</code></div>
        <div class="row"><button type="button" onclick={() => linkCopy.copy(pc.link)}>{linkCopy.done ? 'Copied' : 'Copy link'}</button></div>
      </details>
    {/snippet}
  </WalkStep>
  <WalkStep>On the agent's page, click <b>Install ComfyUI</b>. This page moves on when it is installed.</WalkStep>
</Walk>
<p class="muted">
  Keep the pairing link secret, like a password.
  <button type="button" class="link" onclick={remove} disabled={removing.busy}>Remove {pc.name}</button>
</p>
{#if removing.error}<p class="err">{removing.error}</p>{/if}
