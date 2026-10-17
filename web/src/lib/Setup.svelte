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
  import Walk from './Walk.svelte'
  import WalkGuide from './WalkGuide.svelte'
  import WalkStep from './WalkStep.svelte'
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
  // Every PC has paired (a PC waiting to pair keeps the step open).
  let pcsReady = $derived(pcs.length > 0 && pcs.every((g) => g.seen))
  // Where each PC is in its own setup, from its agent's latest hello (re-sent when ComfyUI's state
  // changes, v1.20.1): the step waits for ComfyUI to be installed on every PC, so the user finishes
  // there before going on. An older agent, or one not running, may not say: "My PC is set up,
  // continue" lets the step go on regardless.
  const pcStage = (g) =>
    !g.seen ? 'pair' : !g.online || !g.info ? 'unknown' : g.info.installing ? 'installing' : g.info.comfyui === 'not_installed' ? 'install' : 'ready'
  let pcStages = $derived(pcs.map(pcStage))
  let pcsConfirmed = $state(false)
  let pcsSetUp = $derived(pcsReady && (pcsConfirmed || pcStages.every((s) => s === 'ready')))
  const PC_WAITING = {
    pair: 'Waiting for your PC to pair.',
    unknown: 'Waiting for your PC. Is the Comfy-Gen agent running?',
    install: 'Waiting for ComfyUI to be installed on your PC.',
    installing: 'ComfyUI is being installed on your PC.',
  }
  let pcWaiting = $derived(PC_WAITING[['pair', 'unknown', 'install', 'installing'].find((s) => pcStages.includes(s))] ?? PC_WAITING.pair)
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
  // Worker, which binds the bucket once R2 is on (the build checks). A Worker made by the setup site
  // instead answers at once ({storage}) and uploads itself again with the bucket: the new version
  // serves within seconds. Coming back to this tab after opening R2 checks by itself.
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
      const r = await api('POST', '/setup/storage')
      if (r.build) {
        storageBuild = true
        return void (await refresh())
      }
      if (!r.storage) return void (storageChecked = true)
      // Uploaded with R2 bound: wait until the new version serves.
      for (let i = 0; i < 15 && !(await api('GET', '/setup/storage')).storage; i++) await new Promise((ok) => setTimeout(ok, 2000))
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

  // Modal
  let modalId = $state('')
  let modalSecret = $state('')
  const buildTask = new Task()
  let packs = $state(null)
  let deployed = $derived(Boolean(modalGpu))
  let modelsReady = $derived(deployed && packs !== null && packs.every((p) => p.on.modal?.state === 'done'))
  // A Modal deploy running: the state names the last deploy build, its log says when it stopped. A
  // Worker made by the setup site (path "oauth") deploys from a Modal Sandbox instead, which the
  // state names until its report arrives.
  let oauth = $derived(info.update_path === 'oauth')
  let finishedBuild = $state(null)
  let building = $derived(oauth ? Boolean(info.modal_deploy) : Boolean(info.build && info.build !== info.update_build && info.build !== finishedBuild))

  // Connect Modal (the oauth path): Modal's sign-in in a new tab; this page waits for the approval,
  // then deploys. The tab is opened at the click (a tab opened after a request is often blocked).
  const connectTask = new Task()
  let connecting = $state(false)
  function connectModal() {
    const tab = window.open('about:blank', '_blank')
    connectTask.run(async () => {
      const { url } = await api('POST', '/modal/connect')
      if (tab) tab.location.href = url
      else window.open(url, '_blank')
      connecting = true
      try {
        while (!(await api('POST', '/modal/connect/wait')).connected) {}
      } finally {
        connecting = false
      }
      await api('POST', '/setup/modal')
      await refresh()
    })
  }

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
      if (oauth) {
        if (withToken) await api('POST', '/modal/token', { token_id: modalId.trim(), token_secret: modalSecret.trim() })
        await api('POST', '/setup/modal')
      } else await api('POST', '/setup/build', withToken ? { modal_token_id: modalId.trim(), modal_token_secret: modalSecret.trim() } : {})
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
    pc: pcsSetUp,
    deploy: deployed && !modalError,
    models: modelsReady,
    claude: Boolean(info.claude_seen),
    finish: false, // where it ends: never ticked
  })
  // Moving on passes over what needs nothing: a step already done (the answer the setup site gave),
  // and the models once Modal is up (they download by themselves).
  let wizardSteps = $derived(
    steps.map((id) => ({
      id, ...STEP[id], ...(id === 'pc' ? { waiting: pcWaiting } : {}), done: done[id],
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

{#snippet typedToken()}
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
{/snippet}

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
      <p>Your images are saved in your own Cloudflare account. It is free up to 10 GB. Cloudflare asks for a card one time to turn it on.</p>
      <Walk>
        <WalkStep>
          Open the storage page in Cloudflare.
          {#snippet controls()}<OpenButton href={r2Url} label="Open Cloudflare storage" onopen={() => (r2Opened = true)} />{/snippet}
        </WalkStep>
        <WalkGuide ids={['r2']}>
          Click <b>Add R2 subscription to my account</b>. It costs $0. If Cloudflare has no card for you, it asks for one.
        </WalkGuide>
        <WalkStep>
          Close the Cloudflare tab and come back to this tab. This page checks by itself and moves on. This takes about a minute.
          {#snippet controls()}
            <button class="secondary" onclick={checkStorage} disabled={storageChecking}>
              {storageTask.busy ? 'Starting…' : storageChecking ? 'Checking…' : 'Check now'}
            </button>
          {/snippet}
        </WalkStep>
      </Walk>
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
        <span class="muted">No graphics card needed. You pay only for the seconds you use. Modal gives you $30 free each month.</span></span>
    </label>
    <label class="choice">
      <input type="radio" name="mode" checked={mode === 'both'} disabled={modeTask.busy} onchange={() => choose('both')} />
      <span><b>{MODES.both.title}</b> <span class="tag green">If you have a powerful graphics card</span><br />
        <span class="muted">Uses your PC when it is on. Uses the cloud when your PC is off.</span></span>
    </label>
    <label class="choice">
      <input type="radio" name="mode" checked={mode === 'pc'} disabled={modeTask.busy} onchange={() => choose('pc')} />
      <span><b>{MODES.pc.title}</b><br />
        <span class="muted">Free. Uses your own graphics card: NVIDIA, AMD on Linux, or a Mac with Apple silicon. The PC must be on.</span></span>
    </label>
    {#if modeTask.error}<p class="err">{modeTask.error}</p>{/if}
    <details class="guide">
      <summary>Only using Claude Desktop, on the PC with the graphics card?</summary>
      <p>The Claude Desktop extension does everything on that PC. You need no accounts.</p>
      <ol class="steps">
        <li><a class="button" href="{RELEASE}Comfy-Gen-MCP.mcpb">Download the extension</a><br />Open the file. Claude Desktop installs it.</li>
        <li>Click the Comfy-Gen tray icon and open its settings page. Click <b>Install ComfyUI</b> there.</li>
        <li>Ask Claude Desktop for an image.</li>
      </ol>
      <p><b>On one PC, use the extension or the Comfy-Gen agent. Never use both.</b> One graphics card is not enough for two.</p>
    </details>
  {:else if current === 'pc'}
    {#if pcs.some((g) => g.seen)}
      <ul class="pc-progress">
        {#each pcs as g, i (g.id)}
          <li>
            <b>{g.name}:</b>
            {#if pcStages[i] === 'pair'}waiting for the agent to pair.
            {:else if pcStages[i] === 'unknown'}paired. Waiting for the agent. Is the Comfy-Gen agent running on this PC?
            {:else if pcStages[i] === 'install'}paired. Now click <b>Install ComfyUI</b> on the agent's page.
            {:else if pcStages[i] === 'installing'}installing ComfyUI…
            {:else}<span class="ok">ready ✓</span>{/if}
          </li>
        {/each}
      </ul>
      {#if pcsReady && !pcsSetUp}
        <p class="muted">Already installed on your PC? <button type="button" class="link" onclick={() => (pcsConfirmed = true)}>My PC is set up, continue</button></p>
      {/if}
    {/if}
    {#if pcsReady && allPaused}<p class="err">{pcs.length > 1 ? 'Every PC is' : 'This PC is'} paused. It makes no images until you resume it. Resume it here or from its tray icon.</p>{/if}
    {#if pairing}
      <Walk>
        <WalkStep>
          On {pcs.length > 1 ? 'the new PC' : 'the PC with the graphics card'}, download the Comfy-Gen agent. Then open it.
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
          Copy this pairing link.
          {#snippet controls()}
            <div class="row"><code>{pairing.link}</code></div>
            <div class="row"><button type="button" onclick={() => linkCopy.copy(pairing.link)}>{linkCopy.done ? 'Copied' : 'Copy link'}</button></div>
          {/snippet}
        </WalkStep>
        <WalkGuide ids={['agent-pair']}>On the agent's page, paste it into <b>Pairing link</b>. It pairs by itself.</WalkGuide>
        <WalkStep>On the agent's page, click <b>Install ComfyUI</b>. This page moves on when it is installed.</WalkStep>
      </Walk>
      <p class="muted">Keep the pairing link secret, like a password. <button type="button" class="link" onclick={removePairing}>Remove {pairing.name}</button></p>
    {:else if pcs.length}
      <GpuList {gpus} {refresh} />
      <div class="row">
        <button type="button" class="secondary" onclick={addPc} disabled={addTask.busy}>{addTask.busy ? 'Adding…' : 'Add another PC'}</button>
      </div>
      <p class="muted">Images are made on the first PC in this list that is available.</p>
    {:else}
      <p>A small program on your PC connects it to this page. It is called the Comfy-Gen agent. You do not need to change your network or router.</p>
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
          <p><b>Modal needs a card before it runs anything.</b> Modal still uses the free $30 each month first.</p>
          <Walk>
            <WalkStep>
              Open the billing page in Modal.
              {#snippet controls()}<OpenButton href={MODAL_BILLING} label="Add a card in Modal" onopen={() => (billingOpened = true)} />{/snippet}
            </WalkStep>
            <WalkStep>Click <b>Manage payment details</b> and add the card.</WalkStep>
            <WalkStep>
              Close the Modal tab and come back to this tab. This page tries again by itself.
              {#snippet controls()}
                <button class="secondary" onclick={() => deploy(false)} disabled={buildTask.busy}>{buildTask.busy ? 'Starting…' : 'Try again now'}</button>
              {/snippet}
            </WalkStep>
          </Walk>
        {:else}
          <p><b>Modal refused it:</b> {modalError}</p>
          <p>If the problem is the token, paste a new one below. If not, fix the problem in Modal. Then try again.</p>
          <button onclick={() => deploy(false)} disabled={buildTask.busy}>{buildTask.busy ? 'Starting…' : 'Try again'}</button>
        {/if}
        {#if deployed}<p class="muted">Until then, your last working setup keeps running.</p>{/if}
      </div>
    {/if}
    {#if building && oauth}
      {#key info.modal_deploy.started}<BuildLog path="/setup/modal/log" takes="about 5 minutes the first time" onfinished={refresh} />{/key}
    {:else if building}
      {#key info.build}<BuildLog takes="about 5 minutes the first time" onfinished={async () => { await refresh(); finishedBuild = info.build }} />{/key}
    {:else if deployed && !modalError}
      <p>Modal is ready.</p>
    {:else if oauth && !needsCard && !modalError}
      <p>Images are made on Modal, in your own Modal account. Modal is a cloud service with graphics cards. Modal gives you $30 free each month.</p>
      <Walk>
        <WalkStep>
          No Modal account yet? Sign up first.
          {#snippet controls()}<OpenButton secondary small href="https://modal.com/signup" label="Sign up at Modal" />{/snippet}
        </WalkStep>
        <WalkStep>
          Connect your Modal account. Modal opens in a new tab and asks you to approve it. Approve it there, then come back here: the setup goes on by itself.
          {#snippet controls()}
            <button onclick={connectModal} disabled={connectTask.busy}>{connecting ? 'Waiting for you to approve in Modal…' : connectTask.busy ? 'Opening Modal…' : 'Connect Modal'}</button>
          {/snippet}
        </WalkStep>
      </Walk>
      {#if connectTask.error}<p class="err">{connectTask.error}</p>{/if}
      {#if buildTask.error}<p class="err">{buildTask.error}</p>{/if}
      {@render typedToken()}
    {:else if !needsCard}
      <p>Images are made on Modal, in your own Modal account. Modal is a cloud service with graphics cards. Modal gives you $30 free each month.</p>
      <Walk>
        <WalkStep>
          No Modal account yet? Sign up first.
          {#snippet controls()}<OpenButton secondary small href="https://modal.com/signup" label="Sign up at Modal" />{/snippet}
        </WalkStep>
        <WalkStep>
          Open the API tokens page in Modal.
          {#snippet controls()}<OpenButton href={MODAL_TOKENS} label="Open Modal's API tokens" />{/snippet}
        </WalkStep>
        <WalkGuide ids={['modal-token']}>
          Click <b>New Token</b>. Then click <b>Create token</b>. Copy the command that Modal shows. Then you can close the Modal tab.
        </WalkGuide>
        <WalkStep>
          Paste the command here. The setup starts by itself.
          {#snippet controls()}
            <input id="mcmd" type="text" aria-label="The Modal command" bind:value={modalCommand} oninput={splitCommand} placeholder="modal token set --token-id ak-… --token-secret as-…" autocomplete="off" disabled={buildTask.busy} />
            {#if buildTask.busy}<p>Starting…</p>{/if}
            {@render typedToken()}
          {/snippet}
        </WalkStep>
      </Walk>
      {#if buildTask.error}<p class="err">{buildTask.error}</p>{/if}
    {/if}
    <!-- A new token once Modal is set up (the steps above have it while they show). -->
    {#if !building && deployed && (needsCard || !modalError)}{@render typedToken()}{/if}
    {@render changeMode()}
  {:else if current === 'models'}
    {#if deployed}
      <p>The models are downloading into your Modal account. They are about 23 GB and take a few minutes. You can go to the next step now.</p>
      <Models gpu="modal" onchange={(p) => (packs = p)} />
    {:else}
      <p>Set up Modal first.</p>
    {/if}
  {:else if current === 'claude'}
    {#if !generatorReady}<p class="err">Finish the steps before this one first. Claude needs a place to make images.</p>{/if}
    <Walk>
      <WalkStep>
        Click <b>Add to claude.ai</b>. This opens <b>Add custom connector</b> on claude.ai, already filled in. Click <b>Add</b>.
        Then click <b>Connect</b>. Keep claude.ai open. You do the next step there.
        {#snippet controls()}<OpenButton href={addConnector} label="Add to claude.ai" />{/snippet}
      </WalkStep>
      <WalkGuide ids={['claude-chat']}>
        In a chat, click <b>+</b>, then <b>Connectors</b>. Turn on Comfy-Gen. Ask Claude for an image. When Claude asks, click
        <b>Always allow</b>. This page moves on when Claude connects.
      </WalkGuide>
    </Walk>
    <details class="guide">
      <summary>Add it by hand, or in another app</summary>
      <p>Your connector URL:</p>
      <ConnectorUrl {info} {refresh} />
      <p>In claude.ai, open <b>Customize → Connectors</b>. Click <b>Add custom connector</b>. Type a name and paste the URL.
        Click <b>Add</b>, then <b>Connect</b>.</p>
    </details>
  {:else if current === 'finish'}
    <p>Open a new chat and turn on Comfy-Gen. Ask Claude for an image. For example:</p>
    <p><i>"Draw a lighthouse on a cliff at dusk, in watercolor."</i></p>
    <OpenButton href="https://claude.ai/new" label="Open a new chat" />
    <p>Then ask for a change, like "make it stormy". You can also attach an image to edit.</p>
    <p class="muted">Models, styles, LoRAs and your GPUs are in Settings. If Claude says the tools are not connected: in claude.ai,
      open <b>Customize → Connectors</b> and click Comfy-Gen. Click <b>Disconnect</b>, then <b>Connect</b>.</p>
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
