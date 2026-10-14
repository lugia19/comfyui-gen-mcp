<script module>
  let lastStep = null // the step shown when the Setup tab was last left, for the page's life
</script>

<script>
  import { onDestroy, onMount } from 'svelte'
  import { api, imagesUrl as imagesUrlOf } from './api.js'
  import BuildLog from './BuildLog.svelte'
  import GpuList from './GpuList.svelte'
  import Models from './Models.svelte'
  import Tour from './Tour.svelte'
  import Wizard from './Wizard.svelte'
  import { Copy, masked, Task } from './task.svelte.js'

  // The Worker's setup, one step at a time (design §8): log in, turn on storage (R2), then the
  // answer to "where should images be made?" (asked on the setup site, which the Deploy button
  // carried here as SETUP_MODE, or asked here), and only that answer's steps: the PC agent, Modal's
  // deploy and models, or a ComfyUI by URL. Then connect Claude. Each step ticks itself from the
  // Worker's state.
  // *onsettings*: opens the Settings tab, from the last step.
  let { info, refresh, onsettings = null } = $props()

  const RELEASE = 'https://github.com/lugia19/comfyui-gen-mcp/releases/latest/download/'
  let showAdvanced = $state(false)

  // The answers, as the setup site words them.
  const MODES = {
    cloud: { title: 'In the cloud (Modal)' },
    pc: { title: 'On my PC' },
    both: { title: 'Both' },
    url: { title: 'A ComfyUI by URL' },
  }
  let gpus = $derived(info.gpus ?? [])
  let modalGpu = $derived(gpus.find((g) => g.kind === 'modal'))
  let urlGpu = $derived(gpus.find((g) => g.kind === 'url'))
  let pcs = $derived(gpus.filter((g) => g.kind === 'pc'))
  let mode = $derived(info.setup_mode ?? null)
  let storage = $derived(info.storage !== false)
  // A step shows for the answer, and for a GPU that already exists (an answer changed later only adds).
  let wantPc = $derived(mode === 'pc' || mode === 'both' || pcs.length > 0)
  let wantModal = $derived(mode === 'cloud' || mode === 'both' || Boolean(modalGpu) || Boolean(info.build && info.build !== info.update_build))
  let wantUrl = $derived(mode === 'url' || Boolean(urlGpu))
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

  // Storage: R2 is turned on by hand (a checkout with a card on file), then Check again rebuilds the
  // Worker, which binds the bucket once R2 is on (the build checks).
  const storageTask = new Task()
  let storageBuild = $state(false) // a Check again started here: show its log
  let storageChecked = $state(false) // that build finished
  let r2Url = $derived(info.cloudflare?.account_id
    ? `https://dash.cloudflare.com/${info.cloudflare.account_id}/r2/overview`
    : 'https://dash.cloudflare.com/?to=/:account/r2/overview')
  function checkStorage() {
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

  // Modal
  let modalId = $state('')
  let modalSecret = $state('')
  const buildTask = new Task()
  let packs = $state(null)
  let deployed = $derived(Boolean(modalGpu))
  let modelsReady = $derived(deployed && packs !== null && packs.every((p) => p.on.modal?.state === 'done'))

  // Modal shows a new token only inside `modal token set --token-id ak-… --token-secret as-…`.
  // The command Modal shows the new token in, pasted whole: it fills the two fields below.
  let modalCommand = $state('')
  let fromCommand = $state(false)
  function splitCommand() {
    const id = modalCommand.match(/--token-id[= ]\s*(ak-\S+)/)
    const secret = modalCommand.match(/--token-secret[= ]\s*(as-\S+)/)
    fromCommand = Boolean(id && secret)
    if (id) modalId = id[1]
    if (secret) modalSecret = secret[1]
  }

  // A deploy Modal refused (no card on file, a bad token): its reason, from the build.
  // Shown after a redeploy too (an update build, a new token): the last one that worked keeps running.
  let modalError = $derived(info.modal_error || '')
  let needsCard = $derived(/payment method|billing|card/i.test(modalError))

  function deployModal(e) {
    e?.preventDefault()
    buildTask.run(async () => {
      // Try again sends no token: the build keeps the one stored with the last deploy.
      await api('POST', '/setup/build', e ? { modal_token_id: modalId.trim(), modal_token_secret: modalSecret.trim() } : {})
      modalSecret = ''
      modalCommand = ''
      fromCommand = false
      await refresh()
    })
  }

  // A ComfyUI URL
  let directUrl = $state('')
  const directTask = new Task()
  function saveDirect(e) {
    e.preventDefault()
    directTask.run(async () => (await api('POST', '/setup/generator', { base_url: directUrl.trim() }), await refresh()))
  }

  // Claude
  let showUrl = $state(false) // the connector URL holds its secret: masked, as screenshots get shared
  const connectorCopy = new Copy()
  let generatorReady = $derived(storage && gpus.some((g) => g.kind !== 'pc' || g.online))

  async function rotate() {
    if (!confirm('Make a new connector URL? The old one stops working, so you will need to add the new one in claude.ai.')) return
    await api('POST', '/setup/rotate-connector')
    await refresh()
  }

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
    storage: { title: 'Turn on storage', short: 'Storage', waiting: 'Waiting for storage: turn R2 on, then press Check again.' },
    mode: { title: 'Where should images be made?', short: 'Where', waiting: 'Choose an answer.' },
    pc: { title: 'Set up your PC', short: 'PC', waiting: 'Waiting for your PC to pair.' },
    deploy: { title: 'Deploy ComfyUI to Modal', short: 'Modal', waiting: 'Waiting for the deploy to finish.' },
    models: { title: 'Download the models', short: 'Models', waiting: 'Waiting for the deploy.' },
    url: { title: 'Connect your ComfyUI', short: 'ComfyUI', waiting: 'Waiting for your ComfyUI.' },
    claude: { title: 'Connect Claude', short: 'Claude', waiting: 'Waiting for Claude to connect: ask it for an image.' },
    finish: { title: "You're set", short: 'Done' },
  }
  let steps = $derived.by(() => {
    const list = ['storage', 'mode']
    if (wantPc) list.push('pc')
    if (wantModal) list.push('deploy', 'models')
    if (wantUrl) list.push('url')
    return [...list, 'claude', 'finish']
  })
  let done = $derived({
    storage,
    mode: Boolean(mode),
    pc: pcsReady,
    deploy: deployed && !modalError,
    models: modelsReady,
    url: Boolean(urlGpu),
    claude: Boolean(info.claude_seen),
    finish: false, // where it ends: never ticked
  })
  let wizardSteps = $derived(steps.map((id) => ({ id, ...STEP[id], done: done[id], canLeave: id === 'models' ? deployed : done[id] })))
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
  let pop = $state(null) // an optional walkthrough over the page: [ids, title]
  // What a step asks you to fill in shows once its walkthrough reaches the step that gives it to you
  // (*at*: the step showing; null when the walkthrough can't show, so everything does). A finished
  // step shows it at once.
  const reached = (at, n) => at === null || (at ?? 0) >= n
  let pairAt = $state()
  let modalAt = $state()
  let claudeAt = $state()
  let imagesUrl = $derived(imagesUrlOf(info))
</script>

{#if current}
<Wizard steps={wizardSteps} bind:current end={onsettings && { label: 'Go to settings', onclick: onsettings }}>
  {#if current === 'storage'}
    {#if storage}
      <p>Storage is on: images and LoRAs are kept in your Worker's R2 bucket, so any GPU can edit any image.</p>
      {#if imagesUrl}
        <p class="muted">
          <a class="button secondary" href={imagesUrl} target="_blank" rel="noopener">Your images on Cloudflare</a>
          Every image made, in the R2 bucket's <code>img/</code> folder; they expire after a year.
        </p>
      {/if}
    {:else}
      <p>
        Images and LoRAs are kept in your Worker's storage (Cloudflare R2), so any GPU can edit any image. R2 is
        free up to 10 GB, but Cloudflare wants a card on file for it, so it is turned on once, by hand.
      </p>
      <p><a class="button" href={r2Url} target="_blank" rel="noopener">Open R2 in your Cloudflare dashboard</a></p>
      <Tour ids={['r2']} mode="wizard">
        <ol>
          <li>Click <b>Add R2 subscription to my account</b>. It's $0 due, and asks for a card first if the account has none.</li>
        </ol>
      </Tour>
      <p>Nothing is charged while you stay inside the free amounts. Back here, press <b>Check again</b>: your Worker redeploys
        (about a minute) and picks up its storage.</p>
      <button onclick={checkStorage} disabled={storageTask.busy || (storageBuild && !storageChecked)}>
        {storageTask.busy ? 'Starting…' : storageBuild && !storageChecked ? 'Checking…' : 'Check again'}
      </button>
      {#if storageTask.error}<p class="err">{storageTask.error}</p>{/if}
      {#if storageChecked}<p class="err">R2 still isn't on in this account: add the R2 subscription, then check again.</p>{/if}
      {#if storageBuild}
        {#key info.update_build}<BuildLog takes="about a minute" onfinished={async () => { await refresh(); storageChecked = true }} />{/key}
      {/if}
    {/if}
    <p class="muted">
      Cloudflare already sets up a $10 budget alert, which emails if it ever costs anything; lower it if you like. It warns;
      it doesn't stop anything.
      <button type="button" class="link" onclick={() => (pop = [['cf-budget'], 'The budget alert'])}>Show me where</button>
    </p>
  {:else if current === 'mode'}
    <label class="choice">
      <input type="radio" name="mode" checked={mode === 'both'} disabled={modeTask.busy} onchange={() => choose('both')} />
      <span><b>{MODES.both.title}</b> <span class="tag green">Recommended if you have a powerful GPU</span><br />
        <span class="muted">Your PC when it is on (NVIDIA, AMD on Linux, or an Apple silicon Mac), the cloud when it is off.</span></span>
    </label>
    <label class="choice">
      <input type="radio" name="mode" checked={mode === 'cloud'} disabled={modeTask.busy} onchange={() => choose('cloud')} />
      <span><b>{MODES.cloud.title}</b> <span class="tag">Recommended for most people</span><br />
        <span class="muted">No GPU needed, and it works with your PC off. Billed per second while it generates; new Modal accounts get $30 of free compute a month.</span></span>
    </label>
    <label class="choice">
      <input type="radio" name="mode" checked={mode === 'pc'} disabled={modeTask.busy} onchange={() => choose('pc')} />
      <span><b>{MODES.pc.title}</b><br />
        <span class="muted">Your own GPU (NVIDIA, AMD on Linux, or an Apple silicon Mac), nothing billed. The PC has to be on to make images.</span></span>
    </label>
    {#if showAdvanced || mode === 'url'}
      <label class="choice">
        <input type="radio" name="mode" checked={mode === 'url'} disabled={modeTask.busy} onchange={() => choose('url')} />
        <span><b>{MODES.url.title}</b><br />
          <span class="muted">A ComfyUI you already run, reachable from the internet.</span></span>
      </label>
    {:else}
      <button type="button" class="link" onclick={() => (showAdvanced = true)}>Advanced: a ComfyUI by URL</button>
    {/if}
    {#if modeTask.error}<p class="err">{modeTask.error}</p>{/if}
    {#if mode}<p class="muted">{info.mode_from_site ? 'Your answer on the setup site. ' : ''}Changing this only adds steps; a GPU you no longer want is removed from the GPU list.</p>{/if}
    <details class="guide">
      <summary>Only using Claude Desktop, on the PC with the GPU?</summary>
      <p>The Claude Desktop extension does it all on that PC, with no Worker and no accounts:</p>
      <ol>
        <li>Download <a href="{RELEASE}Comfy-Gen-MCP.mcpb">Comfy-Gen-MCP.mcpb</a> and open it: Claude Desktop installs it.</li>
        <li>The Comfy-Gen icon appears in the tray. Open its settings page from there, choose your GPU and install ComfyUI.</li>
        <li>Ask Claude Desktop for an image.</li>
      </ol>
      <p><b>Use the extension or this Worker's agent on a PC, never both:</b> each runs its own ComfyUI, and two don't fit on one GPU.</p>
      <p class="muted">This Worker costs nothing idle: keep it for claude.ai and the phone app through Modal, or delete it from your Cloudflare dashboard.</p>
    </details>
  {:else if current === 'pc'}
    {#if pcsReady && allPaused}<p class="err">{pcs.length > 1 ? 'Every PC is' : 'This PC is'} paused: it won't take images until resumed (here or from its tray icon).</p>{/if}
    {#if pairing}
      <p>
        On {pcs.length > 1 ? 'the new PC' : 'the PC with the GPU'}, download the agent and run it:
        <a href="{RELEASE}comfy-gen-agent-windows.exe">Windows</a>,
        <a href="{RELEASE}comfy-gen-agent-macos.zip">macOS (Apple silicon)</a> or
        <a href="{RELEASE}comfy-gen-agent-linux">Linux</a>.
      </p>
      <p class="muted">
        It isn't signed yet: on Windows choose <b>More info → Run anyway</b>; on Linux, <code>chmod +x</code> it first. On a
        Mac, unzip it and open it; macOS refuses it the first time (click <b>Done</b>), so open <b>System Settings → Privacy
        &amp; Security</b>, click <b>Open Anyway</b> next to comfy-gen-agent, and <b>Open Anyway</b> again when it asks.
      </p>
      <Tour ids={['agent-pair']} mode="wizard" bind:at={pairAt}>
        <ol>
          <li>Its page opens in your browser. Paste this pairing link into <b>Pairing link</b>.</li>
          <li>Click <b>Pair</b>.</li>
        </ol>
      </Tour>
      {#if reached(pairAt, 1)}
        <div class="row"><code>{pairing.link}</code></div>
        <div class="row"><button type="button" onclick={() => linkCopy.copy(pairing.link)}>{linkCopy.done ? 'Copied' : 'Copy link'}</button></div>
        <p class="muted">The link lets a PC generate for this Worker: treat it like a password. Once paired, install
          ComfyUI from the agent's page: it finds the models of ComfyUI installs you already have.</p>
      {/if}
      <p class="muted"><button type="button" class="link" onclick={removePairing}>Remove {pairing.name}</button> to back out.</p>
    {:else if pcs.length}
      <GpuList {gpus} {refresh} />
      <div class="row">
        <button type="button" class="secondary" onclick={addPc} disabled={addTask.busy}>{addTask.busy ? 'Adding…' : 'Add another PC'}</button>
      </div>
      <p class="muted">Images are made on the GPUs listed, tried in this order. The LoRAs already on a paired PC are
        copied into the Worker's storage, so every GPU gets them.</p>
    {:else}
      <p>
        Your PC runs a small agent that connects out to this Worker: nothing to open on your network. Add the PC, and
        this page gives you the agent's download and its pairing link.
      </p>
      <div class="row">
        <button type="button" onclick={addPc} disabled={addTask.busy}>{addTask.busy ? 'Adding…' : 'Add a PC'}</button>
      </div>
    {/if}
    {#if addTask.error}<p class="err">{addTask.error}</p>{/if}
  {:else if current === 'deploy'}
    <p>
      Images are generated by ComfyUI on <a href="https://modal.com" target="_blank" rel="noopener">Modal</a>, in
      your own account. New accounts get $30 of free compute a month.
    </p>
    {#if modalError}
      <div class="failed">
        <p><b>Modal refused the deploy:</b> {modalError}</p>
        {#if deployed}<p class="muted">ComfyUI on Modal still runs the last deploy that worked.</p>{/if}
        {#if needsCard}
          <p>
            Add a card in Modal: <a href="https://modal.com/settings" target="_blank" rel="noopener">Settings</a> →
            <b>Usage &amp; billing</b> → <b>Manage payment details</b>. The free $30 is still used first. Then try again.
          </p>
        {:else}
          <p>If the token is the problem, make a new one below and deploy with it. Otherwise fix it in Modal and try again.</p>
        {/if}
        <button onclick={() => deployModal()} disabled={buildTask.busy}>{buildTask.busy ? 'Starting…' : 'Try again'}</button>
        <span class="muted">with the token you gave last time</span>
      </div>
    {/if}
    <p class="muted">New to Modal? <a href="https://modal.com/signup" target="_blank" rel="noopener">Sign up</a> first (with GitHub is
      simplest: the same account your Worker's copy lives in).</p>
    <Tour ids={['modal-billing', 'modal-token']} mode="wizard" bind:at={modalAt}>
      <ol>
        <li><b>Add a card first:</b> Modal runs GPUs only with a card on file, even on the free $30
          (<b>Settings → Usage &amp; billing → Manage payment details</b>). Without one the deploy fails.</li>
        <li>In Modal, open <b>Settings → API tokens &amp; service users</b>, click <b>New Token</b>, then
          <b>Create token</b> (the name is optional).</li>
        <li>Modal shows the token once, inside a command: <code>modal token set --token-id ak-… --token-secret as-…</code>.
          Copy the whole command with its copy button and paste it into <b>Modal command</b> below.</li>
      </ol>
    </Tour>
    {#if reached(modalAt, 5) || deployed}
      <form onsubmit={deployModal}>
        <label for="mcmd">Modal command</label>
        <input id="mcmd" type="text" bind:value={modalCommand} oninput={splitCommand} placeholder="modal token set --token-id ak-… --token-secret as-…" autocomplete="off" />
        {#if fromCommand}<p class="muted">Got the ID and secret from the command.</p>{/if}
        <details class="guide">
          <summary>Or enter them yourself</summary>
          <label for="mid">Token ID</label>
          <input id="mid" type="text" bind:value={modalId} placeholder="ak-…" autocomplete="off" />
          <label for="msec">Token secret</label>
          <input id="msec" type="password" bind:value={modalSecret} placeholder="as-…" autocomplete="off" />
        </details>
        <button type="submit" disabled={buildTask.busy || !modalId.trim() || !modalSecret.trim()}>
          {buildTask.busy ? 'Starting…' : deployed ? 'Deploy again' : 'Deploy to Modal'}
        </button>
        {#if buildTask.error}<p class="err">{buildTask.error}</p>{/if}
      </form>
      <p class="muted">The ID and secret are stored only as build secrets, used to deploy ComfyUI into your Modal account. The
        first deploy takes about 5 minutes (it builds the ComfyUI image); later ones about a minute.</p>
      <p class="muted">Optional: Modal's <b>Spend limit</b> caps what it can bill: once charges pass it, with the free credits used
        first, all work stops. At $0 you never pay past the credits.
        <button type="button" class="link" onclick={() => (pop = [['modal-limit'], "Modal's spend limit"])}>Show me where</button></p>
    {/if}
    {#if info.build && info.build !== info.update_build}
      {#key info.build}<BuildLog takes="about 5 minutes the first time, about a minute after" onfinished={refresh} />{/key}
    {/if}
  {:else if current === 'models'}
    {#if deployed}
      <p>The models download straight into your Modal account (about 23 GB for the default choices, a few minutes).
        You can go on to the next step meanwhile.</p>
      <Models gpu="modal" onchange={(p) => (packs = p)} />
    {:else}
      <p class="muted">This comes after the deploy to Modal.</p>
    {/if}
  {:else if current === 'url'}
    <form onsubmit={saveDirect}>
      <label for="url">ComfyUI URL</label>
      <input id="url" type="url" bind:value={directUrl} placeholder="https://comfy.example.com" />
      <p class="muted">It must be reachable from the internet. The Worker checks <code>/system_stats</code> before saving.</p>
      <button type="submit" disabled={directTask.busy || !directUrl.trim()}>{directTask.busy ? 'Checking…' : 'Use this ComfyUI'}</button>
      {#if directTask.error}<p class="err">{directTask.error}</p>{/if}
    </form>
  {:else if current === 'claude'}
    <p>Add this Worker to claude.ai as a custom connector: the walkthrough gives you its URL when you get to pasting it.</p>
    <Tour ids={['claude-connector', 'claude-chat']} mode="wizard" bind:at={claudeAt}>
      <ol>
        <li>In claude.ai, open <b>Customize → Connectors</b>, then <b>+</b> → <b>Add custom connector</b>.</li>
        <li>Name it anything (Comfy-Gen, say), paste the URL, and click <b>Continue</b>.</li>
        <li>Under <b>Authentication</b>, leave <b>No sign-in</b>. Its warning that anyone with the URL can use the connector is
          expected: the URL is the secret.</li>
        <li>Click <b>Add</b>, then <b>Connect</b>.</li>
        <li>In a chat, turn it on under <b>+ → Connectors</b>. The first image asks to allow the tool: choose <b>Always allow</b>.</li>
      </ol>
    </Tour>
    {#if reached(claudeAt, 6) || info.claude_seen}
      <p>Your connector URL:</p>
      <div class="row"><code>{showUrl ? info.connector_url : masked(info.connector_url)}</code></div>
      <div class="row">
        <button onclick={() => connectorCopy.copy(info.connector_url)}>{connectorCopy.done ? 'Copied' : 'Copy URL'}</button>
        <button class="secondary" onclick={() => (showUrl = !showUrl)}>{showUrl ? 'Hide' : 'Show'}</button>
        <button class="secondary" onclick={rotate}>Make a new URL</button>
      </div>
      <p class="muted">Anyone with this URL can generate images with your setup. Treat it like a password. If Claude ever says the
        tools aren't connected, open the connector in <b>Customize → Connectors</b> and click <b>Disconnect</b>, then <b>Connect</b>.</p>
    {/if}
    {#if !generatorReady}<p class="muted">Finish the steps before this one first: Claude needs a GPU to generate on.</p>{/if}
  {:else if current === 'finish'}
    <p>In a new chat, with the connector turned on, try:</p>
    <p><i>"Draw a lighthouse on a cliff at dusk, in watercolor."</i></p>
    <p class="muted">
      Then ask for a change ("make it stormy"), or attach an image to edit.
    </p>
    <p>
      Everything else is in <b>Settings</b>: the models and their options, LoRAs, your GPUs (names, order, keep-warm),
      image encryption and this page's password.
    </p>
  {/if}
</Wizard>
{/if}

{#if pop}
  <Tour ids={pop[0]} title={pop[1]} mode="overlay" onclose={() => (pop = null)}>
    <p>This walkthrough couldn't be loaded.</p>
  </Tour>
{/if}

<style>
  .failed {
    border: 1px solid var(--err);
    border-radius: 8px;
    padding: 4px 12px 12px;
    margin: 10px 0;
  }
</style>
