<script>
  import { onDestroy, onMount } from 'svelte'
  import { api, GUIDE, hideFigure } from './api.js'
  import BuildLog from './BuildLog.svelte'
  import GpuList from './GpuList.svelte'
  import Models from './Models.svelte'
  import SetPassword from './SetPassword.svelte'
  import Step from './Step.svelte'

  // The Worker's setup, one step at a time: log in, the GPUs (PCs with the agent, Modal, or under
  // Advanced a ComfyUI URL, in priority order), Modal's deploy and models when it is wanted, then
  // connect Claude. Someone who only uses Claude Desktop on the PC with the GPU is pointed at the
  // extension instead: it needs no Worker. Each step ticks itself from the Worker's state.
  let { info, refresh } = $props()

  const RELEASE = 'https://github.com/lugia19/comfyui-gen-mcp/releases/latest/download/'
  const CHOICE_KEY = 'comfy-gen-setup-choice'
  let showAdvanced = $state(false)

  // What the user means to add ('modal' or 'url'), remembered in this browser until it exists.
  let picked = $state(null)
  try {
    picked = localStorage.getItem(CHOICE_KEY)
  } catch {}
  let gpus = $derived(info.gpus ?? [])
  let modalGpu = $derived(gpus.find((g) => g.kind === 'modal'))
  let urlGpu = $derived(gpus.find((g) => g.kind === 'url'))
  let pcs = $derived(gpus.filter((g) => g.kind === 'pc'))
  let wantModal = $derived(Boolean(modalGpu) || Boolean(info.build && info.build !== info.update_build) || picked === 'modal')
  let wantUrl = $derived(Boolean(urlGpu) || picked === 'url')
  // Done once there is a GPU and every PC has paired (a PC waiting to pair keeps the step open).
  let gpusReady = $derived(gpus.length > 0 && pcs.every((g) => g.seen))

  function choose(c) {
    picked = c
    try {
      localStorage.setItem(CHOICE_KEY, c)
    } catch {}
  }

  let addBusy = $state(false)
  let addError = $state('')
  async function addPc() {
    addBusy = true
    addError = ''
    try {
      await api('POST', '/gpus/pc')
      await refresh()
    } catch (e) {
      addError = e.message
    } finally {
      addBusy = false
    }
  }

  // Modal
  let modalId = $state('')
  let modalSecret = $state('')
  let buildBusy = $state(false)
  let buildError = $state('')
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

  async function deployModal(e) {
    e?.preventDefault()
    buildBusy = true
    buildError = ''
    try {
      // Try again sends no token: the build keeps the one stored with the last deploy.
      await api('POST', '/setup/build', e ? { modal_token_id: modalId.trim(), modal_token_secret: modalSecret.trim() } : {})
      modalSecret = ''
      modalCommand = ''
      fromCommand = false
      await refresh()
    } catch (err) {
      buildError = err.message
    } finally {
      buildBusy = false
    }
  }

  // A ComfyUI URL
  let directUrl = $state('')
  let directBusy = $state(false)
  let directError = $state('')

  async function saveDirect(e) {
    e.preventDefault()
    directBusy = true
    directError = ''
    try {
      await api('POST', '/setup/generator', { base_url: directUrl.trim() })
      await refresh()
    } catch (err) {
      directError = err.message
    } finally {
      directBusy = false
    }
  }

  // Claude
  let copied = $state(false)
  let generatorReady = $derived(gpus.some((g) => g.kind !== 'pc' || g.online))

  async function copyConnector() {
    await navigator.clipboard.writeText(info.connector_url)
    copied = true
    setTimeout(() => (copied = false), 1500)
  }

  async function rotate() {
    if (!confirm('Make a new connector URL? The old one stops working, so you will need to add the new one in claude.ai.')) return
    await api('POST', '/setup/rotate-connector')
    await refresh()
  }

  // Updates: the Worker checks for a release daily; Update now starts the same build at once.
  let update = $state(null) // {current, latest, newer, can, build}
  let updating = $state(false) // started from this page: keep its log after it finishes
  let updateFinished = $state(false) // that build stopped (the button returns if it failed)
  let updateError = $state('')

  async function loadUpdate() {
    try {
      update = await api('GET', '/update')
    } catch {
      update = null // GitHub unreachable: say nothing
    }
  }

  async function updateNow() {
    updateError = ''
    try {
      await api('POST', '/update')
      updating = true
      updateFinished = false
      await loadUpdate()
      await refresh()
    } catch (e) {
      updateError = e.message
    }
  }
  onMount(loadUpdate)

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

  const status = (done, ready = true) => (done ? 'done' : ready ? 'current' : 'todo')

  // Step numbers follow what is wanted.
  let steps = $derived.by(() => {
    const list = []
    if (wantModal) list.push('deploy', 'models')
    if (wantUrl) list.push('url')
    return list
  })
  const num = (id) => 3 + steps.indexOf(id)
  let claudeN = $derived(3 + steps.length)
</script>

<Step n={1} title="Log in" status="done" summary={info.cloudflare ? `Worker ${info.cloudflare.script}` : 'Logged in'}>
  {#if info.cloudflare}
    <p class="muted">
      Worker <code>{info.cloudflare.script}</code> in account <code>{info.cloudflare.account_id}</code>. Logging in
      again with a new token replaces the stored one.
    </p>
  {/if}
  <details class="guide">
    <summary>Change the password</summary>
    <SetPassword />
  </details>
</Step>

<Step n={2} title="Your GPUs" status={status(gpusReady)} summary={gpusReady ? gpus.map((g) => g.name).join(', ') : ''}>
  <p>
    Images are made on your GPUs, tried in this order. A PC runs a small agent that connects out to this Worker
    (nothing to open on your network); Modal runs in the cloud and bills only while it generates. Images and LoRAs
    are kept in this Worker's storage, so any GPU can edit any image.
  </p>
  <GpuList {gpus} {refresh} />
  <div class="row">
    <button type="button" onclick={addPc} disabled={addBusy}>{addBusy ? 'Adding…' : pcs.length ? 'Add another PC' : 'Add a PC'}</button>
    {#if !wantModal}<button type="button" class="secondary" onclick={() => choose('modal')}>Add Modal</button>{/if}
    {#if !wantUrl && showAdvanced}<button type="button" class="secondary" onclick={() => choose('url')}>Add a ComfyUI by URL</button>{/if}
    {#if !wantUrl && !showAdvanced}<button type="button" class="secondary" onclick={() => (showAdvanced = true)}>Advanced</button>{/if}
  </div>
  {#if addError}<p class="err">{addError}</p>{/if}
  <details class="guide">
    <summary>Only using Claude Desktop, on the PC with the GPU?</summary>
    <p>The Claude Desktop extension does it all on that PC, with no Worker and no accounts:</p>
    <ol>
      <li>Download <a href="{RELEASE}Comfy-Gen-MCP.mcpb">Comfy-Gen-MCP.mcpb</a> and open it: Claude Desktop installs it.</li>
      <li>The Comfy-Gen icon appears in the tray. Open its settings page from there, choose your GPU and install ComfyUI.</li>
      <li>Ask Claude Desktop for an image.</li>
    </ol>
    <p class="muted">This Worker costs nothing idle: keep it for claude.ai and the phone app, or delete it from your Cloudflare dashboard.</p>
  </details>
</Step>

{#if wantModal}
  <Step
    n={num('deploy')}
    title="Deploy ComfyUI to Modal"
    status={status(deployed && !modalError)}
    summary={modalError ? 'The last deploy failed' : deployed ? 'ComfyUI runs on Modal' : ''}
  >
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
        <button onclick={() => deployModal()} disabled={buildBusy}>{buildBusy ? 'Starting…' : 'Try again'}</button>
        <span class="muted">with the token you gave last time</span>
      </div>
    {/if}
    <details class="guide">
      <summary>New to Modal? Show me how</summary>
      <ol>
        <li><a href="https://modal.com/signup" target="_blank" rel="noopener">Sign up for Modal</a> (with GitHub is simplest: the same account your Worker's copy lives in).</li>
        <li>Add a card: <b>Settings → Usage &amp; billing → Manage payment details</b>. Modal needs one on file to run
          GPUs; the $30 of free compute each month is used first.</li>
        <li>Then make the token as below.</li>
      </ol>
      <figure><img src="{GUIDE}modal-signup.png" alt="Modal's sign-up page" loading="lazy" onerror={hideFigure} /><figcaption>Signing up.</figcaption></figure>
      <figure><img src="{GUIDE}modal-billing.png" alt="Modal's billing settings, where the card goes" loading="lazy" onerror={hideFigure} /><figcaption>Where the card goes.</figcaption></figure>
    </details>
    <ol>
      <li><b>Add a card first:</b> Modal runs GPUs only with a card on file, even on the free $30
        (<b>Settings → Usage &amp; billing → Manage payment details</b>). Without one the deploy fails.</li>
      <li>In Modal, open <b>Settings → API tokens &amp; service users</b>, click <b>New Token</b>, then
        <b>Create token</b> (the name is optional).</li>
      <li>Modal shows the token once, inside a command: <code>modal token set --token-id ak-… --token-secret as-…</code>.
        Copy the whole command with its copy button and paste it into <b>Modal command</b> below: the ID and secret
        are picked out of it. They are stored only as build secrets, used to deploy ComfyUI into your Modal account.</li>
    </ol>
    <figure><img src="{GUIDE}modal-tokens.png" alt="Modal's API tokens settings with the New Token button" loading="lazy" onerror={hideFigure} /><figcaption>Settings → API tokens &amp; service users.</figcaption></figure>
    <figure><img src="{GUIDE}modal-token-created.png" alt="A new Modal token, shown inside a modal token set command" loading="lazy" onerror={hideFigure} /><figcaption>The command holding the ID and secret.</figcaption></figure>
    <p class="muted">The first deploy takes about 5 minutes: it builds the ComfyUI image.</p>
    <form onsubmit={deployModal}>
      <label for="mcmd">Modal command</label>
      <input id="mcmd" type="text" bind:value={modalCommand} oninput={splitCommand} placeholder="modal token set --token-id ak-… --token-secret as-…" autocomplete="off" />
      {#if fromCommand}<p class="muted">Got the ID and secret from the command.</p>{/if}
      <p class="muted">Or enter them yourself:</p>
      <label for="mid">Token ID</label>
      <input id="mid" type="text" bind:value={modalId} placeholder="ak-…" autocomplete="off" />
      <label for="msec">Token secret</label>
      <input id="msec" type="password" bind:value={modalSecret} placeholder="as-…" autocomplete="off" />
      <button type="submit" disabled={buildBusy || !modalId.trim() || !modalSecret.trim()}>
        {buildBusy ? 'Starting…' : deployed ? 'Deploy again' : 'Deploy to Modal'}
      </button>
      {#if buildError}<p class="err">{buildError}</p>{/if}
    </form>
    {#if info.build && info.build !== info.update_build}
      {#key info.build}<BuildLog onfinished={refresh} />{/key}
    {/if}
  </Step>

  <Step
    n={num('models')}
    title="Download the models"
    status={status(modelsReady, deployed)}
    summary={modelsReady ? 'On your Modal Volume' : ''}
  >
    {#if deployed}
      <p>The models download straight into your Modal account (about 20 GB for the default choices, a few minutes).
        You can go on to the next step meanwhile.</p>
      <Models gpu="modal" onchange={(p) => (packs = p)} />
    {/if}
  </Step>
{/if}

{#if wantUrl}
  <Step n={num('url')} title="Connect your ComfyUI" status={status(Boolean(urlGpu))} summary={urlGpu ? urlGpu.base_url : ''}>
    <form onsubmit={saveDirect}>
      <label for="url">ComfyUI URL</label>
      <input id="url" type="url" bind:value={directUrl} placeholder="https://comfy.example.com" />
      <p class="muted">It must be reachable from the internet. The Worker checks <code>/system_stats</code> before saving.</p>
      <button type="submit" disabled={directBusy || !directUrl.trim()}>{directBusy ? 'Checking…' : 'Use this ComfyUI'}</button>
      {#if directError}<p class="err">{directError}</p>{/if}
    </form>
  </Step>
{/if}

<Step
  n={claudeN}
  title="Connect Claude"
  status={status(info.claude_seen, generatorReady)}
  summary={info.claude_seen ? 'Claude is connected' : ''}
>
  <ol>
    <li>In claude.ai, open <b>Settings → Connectors → Add custom connector</b>.</li>
    <li>Name it anything (Comfy-Gen, say) and paste this URL:</li>
  </ol>
  <div class="row"><code>{info.connector_url}</code></div>
  <div class="row">
    <button onclick={copyConnector}>{copied ? 'Copied' : 'Copy URL'}</button>
    <button class="secondary" onclick={rotate}>Make a new URL</button>
  </div>
  <p class="muted">Anyone with this URL can generate images with your setup. Treat it like a password.</p>
  {#if !info.claude_seen}<p class="muted">This step ticks itself once Claude has connected.</p>{/if}
</Step>

{#if info.claude_seen}
  <section class="finish">
    <h2>You're set</h2>
    <p>In a new chat, with the connector turned on, try:</p>
    <p><i>"Draw a lighthouse on a cliff at dusk, in watercolor."</i></p>
    <p class="muted">
      Then ask for a change ("make it stormy"), or attach an image to edit. Styles, models and LoRAs are
      in the <b>Settings</b> tab.
    </p>
  </section>
{/if}

{#if update}
  <section>
    <h2>Updates</h2>
    {#if update.newer}
      <p>
        This Worker runs <b>{update.current}</b>; <b>{update.latest}</b> is out.
        <a href="https://github.com/lugia19/comfyui-gen-mcp/releases/tag/{update.latest}" target="_blank" rel="noopener">What's new</a>
      </p>
      <p class="muted">
        It updates itself within a day. Update now starts the build at once: it takes a minute or two, and
        {modalGpu ? 'redeploys ComfyUI on Modal too' : 'image requests keep working meanwhile'}.
      </p>
      {#if !update.building && !(updating && !updateFinished)}
        <button onclick={updateNow} disabled={!update.can}>Update now</button>
        {#if !update.can}<p class="muted">Log in again with a Cloudflare token to update from here.</p>{/if}
      {/if}
    {:else}
      <p class="muted">
        This Worker runs {update.current}, the latest release. It checks for new ones every day.
      </p>
    {/if}
    {#if updateError}<p class="err">{updateError}</p>{/if}
    <!-- The log while an update builds (from here, the daily check or another tab), and after one
         started here, so a failure stays readable. A finished build elsewhere shows nothing. -->
    {#if update.build && (update.building || updating)}
      {#key update.build}
        <BuildLog
          onfinished={async () => {
            await refresh()
            await loadUpdate()
            updateFinished = true
          }}
        />
      {/key}
    {/if}
    {#if updating && updateFinished && !update.newer}
      <p class="ok">Updated. <a href="/" onclick={() => location.reload()}>Reload this page</a> for the new version's settings page.</p>
    {/if}
  </section>
{/if}

<style>
  details.guide {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px;
    margin: 10px 0;
  }
  details.guide summary {
    cursor: pointer;
    font-weight: 600;
  }
  figure {
    margin: 10px 0 14px;
  }
  figure img {
    display: block;
    max-width: 100%;
    height: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  figcaption {
    color: var(--muted);
    font-size: 13px;
    margin-top: 4px;
  }
  .finish {
    border-color: var(--ok);
  }
  .small {
    margin-top: 0;
    padding: 4px 12px;
  }
  .failed {
    border: 1px solid var(--err);
    border-radius: 8px;
    padding: 4px 12px 12px;
    margin: 10px 0;
  }
</style>
