<script module>
  let lastStep = null // the step shown when the Setup tab was last left, for the page's life
</script>

<script>
  import { onDestroy, onMount } from 'svelte'
  import { api } from './api.js'
  import BuildLog from './BuildLog.svelte'
  import ConnectorUrl from './ConnectorUrl.svelte'
  import GpuList from './GpuList.svelte'
  import Models from './Models.svelte'
  import OpenButton from './OpenButton.svelte'
  import Tour from './Tour.svelte'
  import Wizard from './Wizard.svelte'
  import { Copy, onReturn, Task } from './task.svelte.js'

  // The Worker's setup, one step at a time (design §8): log in, turn on storage (R2), then the
  // answer to "where should images be made?" (asked on the setup site, which the Deploy button
  // carried here as SETUP_MODE, or asked here), and only that answer's steps: the PC agent, Modal's
  // deploy and models. Then connect Claude. Each step ticks itself from the
  // Worker's state and moves on by itself; steps already done are passed over.
  // Every page the user has to visit is a button; what they have to do is plain text, in order.
  // *onsettings*: opens the Settings tab, from the last step.
  let { info, refresh, onsettings = null } = $props()

  const RELEASE = 'https://github.com/lugia19/comfyui-gen-mcp/releases/latest/download/'
  const MODAL_TOKENS = 'https://modal.com/settings/tokens'
  const MODAL_BILLING = 'https://modal.com/settings/usage' // "Manage payment details" is there

  // The answers, as the setup site words them.
  const MODES = {
    cloud: { title: 'In the cloud (Modal)' },
    pc: { title: 'On my PC' },
    both: { title: 'Both' },
  }
  let gpus = $derived(info.gpus ?? [])
  let modalGpu = $derived(gpus.find((g) => g.kind === 'modal'))
  let pcs = $derived(gpus.filter((g) => g.kind === 'pc'))
  let mode = $derived(info.setup_mode ?? null)
  let storage = $derived(info.storage !== false)
  // A step shows for the answer, and for a GPU that already exists (an answer changed later only adds).
  let wantPc = $derived(mode === 'pc' || mode === 'both' || pcs.length > 0)
  let wantModal = $derived(mode === 'cloud' || mode === 'both' || Boolean(modalGpu) || Boolean(info.build && info.build !== info.update_build))
  // Done once there is a PC and every PC has paired (a PC waiting to pair keeps the step open).
  let pcsReady = $derived(pcs.length > 0 && pcs.every((g) => g.seen))
  // A paused PC is set up but takes no images.
  let allPaused = $derived(pcs.length > 0 && pcs.every((g) => g.paused))

  const modeTask = new Task()
  const choose = (m) =>
    modeTask.run(async () => {
      await api('POST', '/setup/mode', { mode: m })
      await refresh()
      current = steps[steps.indexOf('mode') + 1]
    })

  // Storage: R2 is turned on by hand (a checkout with a card on file), then a check rebuilds the
  // Worker, which binds the bucket once R2 is on (the build checks). Coming back to this tab after
  // opening R2 checks by itself.
  const storageTask = new Task()
  let storageBuild = $state(false) // a check started here: show its log
  let storageChecked = $state(false) // that build finished
  let r2Opened = $state(false)
  let r2Url = $derived(info.cloudflare?.account_id
    ? `https://dash.cloudflare.com/${info.cloudflare.account_id}/r2/overview`
    : 'https://dash.cloudflare.com/?to=/:account/r2/overview')
  let storageChecking = $derived(storageTask.busy || (storageBuild && !storageChecked))
  function checkStorage() {
    if (storageChecking) return
    storageChecked = false
    storageTask.run(async () => {
      await api('POST', '/setup/storage')
      storageBuild = true
      await refresh()
    })
  }

  const addTask = new Task()
  const addPc = () => addTask.run(async () => (await api('POST', '/gpus/pc'), await refresh()))

  // The PC being paired: the first one its agent hasn't connected from yet. The step shows its
  // download and pairing link until it has.
  let pairing = $derived(pcs.find((g) => !g.seen))
  const linkCopy = new Copy()
  function removePairing() {
    if (confirm(`Remove ${pairing.name}? Its pairing link stops working.`)) addTask.run(async () => (await api('DELETE', `/gpus/${pairing.id}`), await refresh()))
  }
  // The agent for this browser's system first; what each needs to run an app that isn't signed yet.
  const AGENTS = [
    { os: 'windows', label: 'Windows', file: 'comfy-gen-agent-windows.exe',
      run: 'Windows may say it protected your PC: click More info, then Run anyway.' },
    { os: 'mac', label: 'macOS (Apple silicon)', file: 'comfy-gen-agent-macos.zip',
      run: 'Unzip it and open it. The first time, macOS blocks it: click Done, open System Settings → Privacy & Security, click Open Anyway, then Open Anyway again.' },
    { os: 'linux', label: 'Linux', file: 'comfy-gen-agent-linux',
      run: 'Make it executable (chmod +x comfy-gen-agent-linux), then run it.' },
  ]
  const ua = navigator.userAgent
  const thisOs = /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'mac' : /Linux|X11/.test(ua) ? 'linux' : 'windows'
  let agentOs = $state(thisOs)
  let agent = $derived(AGENTS.find((a) => a.os === agentOs))

  // Modal
  let modalId = $state('')
  let modalSecret = $state('')
  const buildTask = new Task()
  let packs = $state(null)
  let deployed = $derived(Boolean(modalGpu))
  let modelsReady = $derived(deployed && packs !== null && packs.every((p) => p.on.modal?.state === 'done'))
  // A Modal deploy running: the state names the last deploy build, its log says when it stopped.
  let finishedBuild = $state(null)
  let building = $derived(Boolean(info.build && info.build !== info.update_build && info.build !== finishedBuild))

  // Modal shows a new token only inside `modal token set --token-id ak-… --token-secret as-…`.
  // Pasted whole, it is split here and the deploy starts at once.
  let modalCommand = $state('')
  function splitCommand() {
    const id = modalCommand.match(/--token-id[= ]\s*(ak-\S+)/)
    const secret = modalCommand.match(/--token-secret[= ]\s*(as-\S+)/)
    if (id) modalId = id[1]
    if (secret) modalSecret = secret[1]
    if (id && secret && !buildTask.busy) deploy(true)
  }

  // A deploy Modal refused (no card on file, a bad token): its reason, from the build. Modal has no
  // way to ask whether a card is on file, so the deploy is the check: refused for the card, the page
  // offers Modal's billing page, and tries again when the user comes back from it.
  // Shown after a redeploy too (an update build, a new token): the last one that worked keeps running.
  let modalError = $derived(info.modal_error || '')
  let needsCard = $derived(/payment method|billing|card/i.test(modalError))
  let billingOpened = $state(false)

  // With the token given here, or (*withToken* false: Try again) the one stored with the last deploy.
  function deploy(withToken) {
    buildTask.run(async () => {
      await api('POST', '/setup/build', withToken ? { modal_token_id: modalId.trim(), modal_token_secret: modalSecret.trim() } : {})
      modalSecret = ''
      modalCommand = ''
      await refresh()
    })
  }
  function deployTyped(e) {
    e.preventDefault()
    deploy(true)
  }

  // Coming back to this tab from a page a button opened: check what the user did there.
  $effect(() =>
    onReturn(() => {
      if (current === 'storage' && r2Opened && !storage) checkStorage()
      if (current === 'deploy' && billingOpened && needsCard && !buildTask.busy && !building) deploy(false)
    }),
  )

  // Claude: claude.ai's "Add custom connector" dialog, opened with the name and URL filled in.
  let generatorReady = $derived(storage && gpus.some((g) => g.kind !== 'pc' || g.online))
  let addConnector = $derived(
    `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Comfy-Gen&connectorUrl=${encodeURIComponent(info.connector_url || '')}`,
  )

  // Waiting on something outside this page: a PC pairing, Claude adding the connector.
  let timer = null
  // Every 5 s while waiting on something; every 20 s while a PC is paired, so its status (paused,
  // offline, a new agent version) follows without a reload.
  let lastSlow = 0
  function poll() {
    timer = setTimeout(async () => {
      const waiting = pcs.some((g) => !g.seen) || (generatorReady && !info.claude_seen)
      const slow = pcs.length > 0 && Date.now() - lastSlow >= 20_000
      if (waiting || slow) {
        lastSlow = Date.now()
        await refresh().catch(() => {})
      }
      poll()
    }, 5000)
  }

  // This tab is remounted each time it opens, with the state from when another tab last loaded it.
  onMount(() => {
    refresh().catch(() => {})
    poll()
  })
  onDestroy(() => clearTimeout(timer))

  // The steps, for the answer given (Log in is behind us: the page needs it). Next leaves a step once
  // it is done; the models download on while Claude is connected, so that step lets you go on.
  const STEP = {
    storage: { title: 'Turn on storage', short: 'Storage', waiting: 'Waiting for storage to turn on.' },
    mode: { title: 'Where should images be made?', short: 'Where', waiting: 'Choose an answer.' },
    pc: { title: 'Set up your PC', short: 'PC', waiting: 'Waiting for your PC to pair.' },
    deploy: { title: 'Set up Modal', short: 'Modal', waiting: 'Waiting for Modal to be ready.' },
    models: { title: 'Download the models', short: 'Models', waiting: 'Waiting for Modal.' },
    claude: { title: 'Connect Claude', short: 'Claude', waiting: 'Waiting for Claude to connect.' },
    finish: { title: "You're set", short: 'Done' },
  }
  let steps = $derived.by(() => {
    const list = ['storage', 'mode']
    if (wantPc) list.push('pc')
    if (wantModal) list.push('deploy', 'models')
    return [...list, 'claude', 'finish']
  })
  let done = $derived({
    storage,
    mode: Boolean(mode),
    pc: pcsReady,
    deploy: deployed && !modalError,
    models: modelsReady,
    claude: Boolean(info.claude_seen),
    finish: false, // where it ends: never ticked
  })
  // Moving on passes over what needs nothing: a step already done (the answer the setup site gave),
  // and the models once Modal is up (they download by themselves).
  let wizardSteps = $derived(
    steps.map((id) => ({
      id, ...STEP[id], done: done[id],
      canLeave: id === 'models' ? deployed : done[id],
      skip: done[id] || (id === 'models' && deployed),
    })),
  )
  // Opens where it was last left on this page (the tab remounts it), else on the first step that
  // can't be left yet: on "You're set" when none. Not "not done": the models step is passable while
  // they download, and its list loads after this runs, so it would always open there. An answer that
  // drops the step shown sends it on the same way.
  let current = $state(null)
  $effect(() => {
    if (current && steps.includes(current)) return
    current = lastStep && steps.includes(lastStep) ? lastStep : (wizardSteps.find((s) => !s.canLeave) ?? { id: 'finish' }).id
  })
  $effect(() => {
    if (current) lastStep = current
  })
  // The answer is passed over once given: the first step after it says what it was, to change it.
  let firstAfterMode = $derived(steps[steps.indexOf('mode') + 1])
</script>

{#snippet changeMode()}
  {#if mode && current === firstAfterMode}
    <p class="muted">Images are made: {MODES[mode]?.title ?? mode}. <button type="button" class="link" onclick={() => (current = 'mode')}>Change</button></p>
  {/if}
{/snippet}

{#if current}
<Wizard steps={wizardSteps} bind:current end={onsettings && { label: 'Go to settings', onclick: onsettings }}>
  {#if current === 'storage'}
    {#if storage}
      <p>Storage is on.</p>
    {:else}
      <p>Your images are kept in your own Cloudflare account. It's free up to 10 GB; Cloudflare asks for a card once to turn it on.</p>
      <ol class="steps">
        <li><OpenButton href={r2Url} label="Open Cloudflare storage" onopen={() => (r2Opened = true)} /></li>
        <li>
          <Tour ids={['r2']} mode="wizard">
            Click <b>Add R2 subscription to my account</b>. It costs $0; Cloudflare asks for a card if it has none.
          </Tour>
        </li>
        <li>
          Close Cloudflare's tab and come back to this one: it checks by itself (about a minute) and moves on.
          <div class="row">
            <button class="secondary" onclick={checkStorage} disabled={storageChecking}>
              {storageTask.busy ? 'Starting…' : storageChecking ? 'Checking…' : 'Check now'}
            </button>
          </div>
        </li>
      </ol>
      {#if storageTask.error}<p class="err">{storageTask.error}</p>{/if}
      {#if storageChecked}<p class="err">Storage still isn't on. Add the R2 subscription in Cloudflare, then come back here.</p>{/if}
      {#if storageBuild}
        {#key info.update_build}<BuildLog takes="about a minute" onfinished={async () => { await refresh(); storageChecked = true }} />{/key}
      {/if}
    {/if}
  {:else if current === 'mode'}
    <label class="choice">
      <input type="radio" name="mode" checked={mode === 'cloud'} disabled={modeTask.busy} onchange={() => choose('cloud')} />
      <span><b>{MODES.cloud.title}</b> <span class="tag">Recommended for most people</span><br />
        <span class="muted">No graphics card needed. Pay per second of use; Modal gives $30 free each month.</span></span>
    </label>
    <label class="choice">
      <input type="radio" name="mode" checked={mode === 'both'} disabled={modeTask.busy} onchange={() => choose('both')} />
      <span><b>{MODES.both.title}</b> <span class="tag green">If you have a powerful graphics card</span><br />
        <span class="muted">Your PC when it's on, the cloud when it's off.</span></span>
    </label>
    <label class="choice">
      <input type="radio" name="mode" checked={mode === 'pc'} disabled={modeTask.busy} onchange={() => choose('pc')} />
      <span><b>{MODES.pc.title}</b><br />
        <span class="muted">Free, on your own graphics card (NVIDIA, AMD on Linux, or a Mac with Apple silicon). The PC must be on.</span></span>
    </label>
    {#if modeTask.error}<p class="err">{modeTask.error}</p>{/if}
    <details class="guide">
      <summary>Only using Claude Desktop, on the PC with the graphics card?</summary>
      <p>The Claude Desktop extension does it all on that PC, with no accounts:</p>
      <ol class="steps">
        <li><a class="button" href="{RELEASE}Comfy-Gen-MCP.mcpb">Download the extension</a><br />Open the file: Claude Desktop installs it.</li>
        <li>Open its settings page from the Comfy-Gen tray icon, and install ComfyUI there.</li>
        <li>Ask Claude Desktop for an image.</li>
      </ol>
      <p><b>Use the extension or a Worker's agent on a PC, never both:</b> two don't fit on one graphics card.</p>
    </details>
  {:else if current === 'pc'}
    {#if pcsReady && allPaused}<p class="err">{pcs.length > 1 ? 'Every PC is' : 'This PC is'} paused: it won't take images until resumed (here or from its tray icon).</p>{/if}
    {#if pairing}
      <ol class="steps">
        <li>
          On {pcs.length > 1 ? 'the new PC' : 'the PC with the graphics card'}, download the Comfy-Gen agent and open it.
          <div class="row">
            <a class="button" href="{RELEASE}{agent.file}">Download for {agent.label}</a>
            {#each AGENTS.filter((a) => a.os !== agentOs) as other (other.os)}
              <button type="button" class="link" onclick={() => (agentOs = other.os)}>{other.label}</button>
            {/each}
          </div>
          <p>{agent.run}</p>
        </li>
        <li>
          Copy this pairing link:
          <div class="row"><code>{pairing.link}</code></div>
          <div class="row"><button type="button" onclick={() => linkCopy.copy(pairing.link)}>{linkCopy.done ? 'Copied' : 'Copy link'}</button></div>
          <Tour ids={['agent-pair']} mode="wizard">Paste it into <b>Pairing link</b> on the agent's page: it pairs by itself.</Tour>
        </li>
        <li>On the agent's page, install ComfyUI. This page moves on once the PC is paired.</li>
      </ol>
      <p class="muted">The pairing link works like a password. <button type="button" class="link" onclick={removePairing}>Remove {pairing.name}</button></p>
    {:else if pcs.length}
      <GpuList {gpus} {refresh} />
      <div class="row">
        <button type="button" class="secondary" onclick={addPc} disabled={addTask.busy}>{addTask.busy ? 'Adding…' : 'Add another PC'}</button>
      </div>
      <p class="muted">Images are made on the first one in this list that's available.</p>
    {:else}
      <p>A small program on your PC, the Comfy-Gen agent, connects it to this page. Nothing to open on your network.</p>
      <div class="row">
        <button type="button" onclick={addPc} disabled={addTask.busy}>{addTask.busy ? 'Adding…' : 'Add a PC'}</button>
      </div>
    {/if}
    {#if addTask.error}<p class="err">{addTask.error}</p>{/if}
    {@render changeMode()}
  {:else if current === 'deploy'}
    {#if modalError && !building}
      <div class="failed">
        {#if needsCard}
          <p><b>Modal needs a card on file before it runs anything.</b> The free $30 a month is still used first.</p>
          <ol class="steps">
            <li><OpenButton href={MODAL_BILLING} label="Add a card in Modal" onopen={() => (billingOpened = true)} /></li>
            <li>Click <b>Manage payment details</b> and add the card.</li>
            <li>Close Modal's tab and come back to this one: it tries again by itself.
              <div class="row"><button class="secondary" onclick={() => deploy(false)} disabled={buildTask.busy}>{buildTask.busy ? 'Starting…' : 'Try again now'}</button></div>
            </li>
          </ol>
        {:else}
          <p><b>Modal refused it:</b> {modalError}</p>
          <p>If the token is the problem, paste a new one below. Otherwise fix it in Modal, then try again.</p>
          <button onclick={() => deploy(false)} disabled={buildTask.busy}>{buildTask.busy ? 'Starting…' : 'Try again'}</button>
        {/if}
        {#if deployed}<p class="muted">The last setup that worked keeps running meanwhile.</p>{/if}
      </div>
    {/if}
    {#if building}
      {#key info.build}<BuildLog takes="about 5 minutes the first time" onfinished={async () => { await refresh(); finishedBuild = info.build }} />{/key}
    {:else if deployed && !modalError}
      <p>Modal is ready.</p>
    {:else if !needsCard}
      <p>Images are made on Modal, a cloud GPU service, in your own account. New accounts get $30 of free use each month.</p>
      <ol class="steps">
        <li>No Modal account yet? <OpenButton secondary small href="https://modal.com/signup" label="Sign up at Modal" /></li>
        <li>
          <OpenButton href={MODAL_TOKENS} label="Open Modal's API tokens" /><br />
          <Tour ids={['modal-token']} mode="wizard">
            Click <b>New Token</b>, then <b>Create token</b>, and copy the command Modal shows. You can close Modal's tab then.
          </Tour>
        </li>
        <li>
          <label for="mcmd">Paste the command here: the setup starts by itself.</label>
          <input id="mcmd" type="text" bind:value={modalCommand} oninput={splitCommand} placeholder="modal token set --token-id ak-… --token-secret as-…" autocomplete="off" disabled={buildTask.busy} />
          {#if buildTask.busy}<p>Starting…</p>{/if}
          {#if buildTask.error}<p class="err">{buildTask.error}</p>{/if}
        </li>
      </ol>
    {/if}
    {#if !building && (deployed || !needsCard)}
      <details class="guide">
        <summary>{deployed ? 'Use a new Modal token' : 'Or type the token ID and secret'}</summary>
        <form onsubmit={deployTyped}>
          <label for="mid">Token ID</label>
          <input id="mid" type="text" bind:value={modalId} placeholder="ak-…" autocomplete="off" />
          <label for="msec">Token secret</label>
          <input id="msec" type="password" bind:value={modalSecret} placeholder="as-…" autocomplete="off" />
          <button type="submit" disabled={buildTask.busy || !modalId.trim() || !modalSecret.trim()}>{buildTask.busy ? 'Starting…' : 'Set up Modal'}</button>
        </form>
      </details>
    {/if}
    {@render changeMode()}
  {:else if current === 'models'}
    {#if deployed}
      <p>The models are downloading into your Modal account (about 23 GB, a few minutes). You can go on meanwhile.</p>
      <Models gpu="modal" onchange={(p) => (packs = p)} />
    {:else}
      <p>This comes after Modal is set up.</p>
    {/if}
  {:else if current === 'claude'}
    {#if !generatorReady}<p class="err">Finish the steps before this one first: Claude needs somewhere to make images.</p>{/if}
    <ol class="steps">
      <li>
        <OpenButton href={addConnector} label="Add to claude.ai" /><br />
        It opens claude.ai's <b>Add custom connector</b> with everything filled in: click <b>Add</b>, then <b>Connect</b>.
        Keep claude.ai open: the next step is there.
      </li>
      <li>
        <Tour ids={['claude-chat']} mode="wizard">
          In a chat, click <b>+</b> → <b>Connectors</b>, turn Comfy-Gen on, and ask for an image. Choose <b>Always allow</b> when
          Claude asks. This page moves on once Claude connects.
        </Tour>
      </li>
    </ol>
    <details class="guide">
      <summary>Add it by hand, or in another app</summary>
      <p>Your connector URL:</p>
      <ConnectorUrl {info} {refresh} />
      <p>In claude.ai, open <b>Customize → Connectors</b>, click <b>Add custom connector</b>, name it, paste the URL, then
        <b>Add</b> and <b>Connect</b>.</p>
    </details>
  {:else if current === 'finish'}
    <p>Ask Claude for an image in a new chat, with Comfy-Gen turned on, for example:</p>
    <p><i>"Draw a lighthouse on a cliff at dusk, in watercolor."</i></p>
    <OpenButton href="https://claude.ai/new" label="Open a new chat" />
    <p>Then ask for a change ("make it stormy"), or attach an image to edit.</p>
    <p class="muted">Models, styles, LoRAs and your GPUs are in Settings. If Claude ever says the tools aren't connected, open
      Comfy-Gen in claude.ai's <b>Customize → Connectors</b> and click <b>Disconnect</b>, then <b>Connect</b>.</p>
  {/if}
</Wizard>
{/if}

<style>
  .failed {
    border: 1px solid var(--err);
    border-radius: 8px;
    padding: 4px 12px 12px;
    margin: 10px 0;
  }
</style>
