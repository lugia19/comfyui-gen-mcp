<script>
  import { onDestroy, onMount } from 'svelte'
  import { api, GUIDE, gpuName, hideFigure, platformName } from './api.js'
  import BuildLog from './BuildLog.svelte'
  import Models from './Models.svelte'
  import Step from './Step.svelte'

  // The Worker's setup, one step at a time: log in, choose where images are made (Modal, the PC,
  // both, or, under Advanced, a ComfyUI URL), that path's steps, then connect Claude. Someone who
  // only uses Claude Desktop on the PC with the GPU is sent to the extension instead: it needs no
  // Worker. Each step ticks itself from
  // the Worker's state: the Modal deploy, the models on the Volume, the PC connected, Claude having
  // listed the tools.
  let { info, refresh } = $props()

  const RELEASE = 'https://github.com/lugia19/comfyui-gen-mcp/releases/latest/download/'
  const CHOICE_KEY = 'comfy-gen-setup-choice'
  const CHOICES = {
    modal: ['In the cloud, on Modal', 'No GPU needed. Modal only runs, and bills, while it generates.'],
    pc: ['On my PC, for claude.ai and the phone app', 'A small agent on your PC runs ComfyUI and connects out to this Worker. Nothing to open on your network.'],
    both: ['My PC, with Modal while it is off', 'The PC is used whenever it is online; Modal answers the rest of the time.'],
    desktop: ['On my PC, only from Claude Desktop', 'The Claude Desktop extension does it all on your PC, with no Worker and no accounts.'],
  }
  const ADVANCED = { url: ['A ComfyUI I already run', 'Reachable from the internet, with its models and nodes already in place.'] }
  const LABELS = { ...CHOICES, ...ADVANCED }
  let showAdvanced = $state(false)

  // The choice follows what is set up; before anything is, it is remembered in this browser only.
  let picked = $state(null)
  try {
    picked = localStorage.getItem(CHOICE_KEY)
  } catch {}
  let gen = $derived(info.generator)
  let pc = $derived(info.pc)
  let choice = $derived(
    gen?.kind === 'url' ? 'url'
    : (gen?.kind === 'modal' || info.build) && pc?.paired ? 'both'
    : gen?.kind === 'modal' || info.build ? (picked === 'both' ? 'both' : 'modal')
    : pc?.paired ? (picked === 'both' ? 'both' : 'pc')
    : picked,
  )
  let wantModal = $derived(choice === 'modal' || choice === 'both')
  let wantPc = $derived(choice === 'pc' || choice === 'both')

  function choose(c) {
    picked = c
    try {
      localStorage.setItem(CHOICE_KEY, c)
    } catch {}
  }

  // Modal
  let modalId = $state('')
  let modalSecret = $state('')
  let buildBusy = $state(false)
  let buildError = $state('')
  let packs = $state(null)
  let deployed = $derived(gen?.kind === 'modal')
  let modelsReady = $derived(deployed && packs !== null && packs.every((p) => p.on.modal?.state === 'done'))

  // Modal shows a new token only inside `modal token set --token-id ak-… --token-secret as-…`.
  function splitCommand() {
    const id = modalId.match(/--token-id[= ]\s*(ak-\S+)/)
    const secret = modalId.match(/--token-secret[= ]\s*(as-\S+)/)
    if (id && secret) {
      modalId = id[1]
      modalSecret = secret[1]
    }
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

  // The PC
  let pcBusy = $state(false)
  let pcError = $state('')
  let copiedLink = $state(false)

  async function pair(again) {
    if (again && !confirm('Make a new pairing link? The PC paired now disconnects until you paste the new link into it.')) return
    pcBusy = true
    pcError = ''
    try {
      await api('POST', '/pc/pair')
      await refresh()
    } catch (e) {
      pcError = e.message
    } finally {
      pcBusy = false
    }
  }

  async function unpair() {
    if (!confirm('Unpair this PC? It disconnects, and images go to Modal (if set up) instead.')) return
    await api('DELETE', '/pc')
    await refresh()
  }

  async function copyLink() {
    await navigator.clipboard.writeText(pc.link)
    copiedLink = true
    setTimeout(() => (copiedLink = false), 1500)
  }

  // Claude
  let copied = $state(false)
  let generatorReady = $derived(Boolean(gen) || Boolean(pc?.connected))

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
      await loadUpdate()
      await refresh()
    } catch (e) {
      updateError = e.message
    }
  }
  onMount(loadUpdate)

  // Waiting on something outside this page: the PC connecting, Claude adding the connector.
  let timer = null
  // Every 5 s while waiting on something; every 20 s while a PC is paired, so its status (paused,
  // offline, a new agent version) follows without a reload.
  let lastSlow = 0
  function poll() {
    timer = setTimeout(async () => {
      const waiting = (pc?.paired && !pc.connected) || (generatorReady && !info.claude_seen)
      const slow = pc?.paired && Date.now() - lastSlow >= 20_000
      if (waiting || slow) {
        lastSlow = Date.now()
        await refresh().catch(() => {})
      }
      poll()
    }, 5000)
  }

  // Pause from here: the agent's tray pause, sent over its connection.
  let pauseBusy = $state(false)
  async function setPaused(paused) {
    pauseBusy = true
    pcError = ''
    try {
      await api('POST', '/pc/pause', { paused })
      await refresh()
    } catch (e) {
      pcError = e.message
    } finally {
      pauseBusy = false
    }
  }
  onMount(poll)
  onDestroy(() => clearTimeout(timer))

  const since = (t) => (t ? new Date(t).toLocaleString() : '')
  const status = (done, ready = true) => (done ? 'done' : ready ? 'current' : 'todo')

  // Step numbers follow the chosen path.
  let steps = $derived.by(() => {
    const list = []
    if (wantModal) list.push('deploy', 'models')
    if (wantPc) list.push('pc')
    if (choice === 'url') list.push('url')
    return list
  })
  const num = (id) => 3 + steps.indexOf(id)
  let claudeN = $derived(3 + steps.length)
</script>

{#snippet pauseButton()}
  <button type="button" class="secondary small" onclick={() => setPaused(!pc.info?.paused)} disabled={pauseBusy}>
    {pauseBusy ? '…' : pc.info?.paused ? 'Resume' : 'Pause'}
  </button>
{/snippet}

<Step n={1} title="Log in" status="done" summary={info.cloudflare ? `Worker ${info.cloudflare.script}` : 'Logged in'}>
  {#if info.cloudflare}
    <p class="muted">
      Worker <code>{info.cloudflare.script}</code> in account <code>{info.cloudflare.account_id}</code>. Logging in
      again with a new token replaces the stored one.
    </p>
  {/if}
</Step>

<Step n={2} title="Choose where images are made" status={status(choice)} summary={choice ? LABELS[choice][0] : ''}>
  {#each Object.entries(showAdvanced || choice === 'url' ? LABELS : CHOICES) as [key, [label, detail]] (key)}
    <label class="choice">
      <input type="radio" name="where" value={key} checked={choice === key} onchange={() => choose(key)} />
      <span><b>{label}</b><br /><span class="muted">{detail}</span></span>
    </label>
  {/each}
  {#if choice !== 'url'}
    <button type="button" class="secondary" onclick={() => (showAdvanced = !showAdvanced)}>
      {showAdvanced ? 'Hide advanced' : 'Advanced'}
    </button>
  {/if}
  {#if (gen || pc?.paired) && !choice}<p class="muted">Pick one to see its steps.</p>{/if}
</Step>

{#if wantModal}
  <Step n={num('deploy')} title="Deploy ComfyUI to Modal" status={status(deployed)} summary={deployed ? 'ComfyUI runs on Modal' : ''}>
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
        Copy the whole command with its copy button and paste it into the first box below: the ID and secret are
        picked out of it. They are stored only as build secrets, used to deploy ComfyUI into your Modal account.</li>
    </ol>
    <figure><img src="{GUIDE}modal-tokens.png" alt="Modal's API tokens settings with the New Token button" loading="lazy" onerror={hideFigure} /><figcaption>Settings → API tokens &amp; service users.</figcaption></figure>
    <figure><img src="{GUIDE}modal-token-created.png" alt="A new Modal token, shown inside a modal token set command" loading="lazy" onerror={hideFigure} /><figcaption>The command holding the ID and secret.</figcaption></figure>
    <p class="muted">The first deploy takes about 5 minutes: it builds the ComfyUI image.</p>
    <form onsubmit={deployModal}>
      <label for="mid">Token ID</label>
      <input id="mid" type="text" bind:value={modalId} oninput={splitCommand} placeholder="ak-… or the whole modal token set command" autocomplete="off" />
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
      <Models backend="modal" onchange={(p) => (packs = p)} />
    {/if}
  </Step>
{/if}

{#if wantPc}
  <Step
    n={num('pc')}
    title="Run the agent on your PC"
    status={status(pc?.connected)}
    summary={pc?.connected ? `${pc.info?.paused ? 'Paused' : 'Connected'}${pc.info?.platform ? `: ${platformName(pc.info.platform)}` : ''}${pc.info?.gpu ? `, GPU: ${gpuName(pc.info.gpu)}` : ''}` : ''}
    actions={pc?.connected ? pauseButton : null}
  >
    {#if !pc?.paired}
      <p>First, make the link that lets your PC connect to this Worker.</p>
      <button onclick={() => pair(false)} disabled={pcBusy}>{pcBusy ? 'Making a link…' : 'Make a pairing link'}</button>
    {:else}
      <ol>
        <li>
          On your PC, download the agent:
          <a href="{RELEASE}comfy-gen-agent-windows.exe">Windows</a>,
          <a href="{RELEASE}comfy-gen-agent-macos.zip">macOS (Apple silicon)</a> or
          <a href="{RELEASE}comfy-gen-agent-linux">Linux</a>, and run it. It is not signed yet: on Windows choose
          <b>More info → Run anyway</b>; on macOS unzip it, right-click it and choose <b>Open</b>; on Linux,
          <code>chmod +x</code> it first.
        </li>
        <li>Its page opens in your browser. Paste this pairing link there:</li>
      </ol>
      <div class="row"><code>{pc.link}</code></div>
      <div class="row">
        <button onclick={copyLink}>{copiedLink ? 'Copied' : 'Copy link'}</button>
        <button class="secondary" onclick={() => pair(true)} disabled={pcBusy}>New link</button>
        <button class="secondary" onclick={unpair}>Unpair</button>
      </div>
      <p class="muted">The link lets a PC generate for this Worker. Treat it like a password.</p>
      <ol start="3">
        <li>On the same page, install ComfyUI. It finds the models of ComfyUI installs you already have.</li>
      </ol>
      {#if pc.connected}
        <p>
          {#if pc.info?.paused}
            <b>Paused:</b> <span class="muted">not taking image requests{choice === 'both' ? ', so Modal answers' : ''}.</span>
          {:else}
            <b class="ok">Connected</b> <span class="muted">since {since(pc.since)}</span>
          {/if}
          {#if pc.info}<span class="muted">· agent {pc.info.version} on {platformName(pc.info.platform)}{#if pc.info.gpu}, GPU: {gpuName(pc.info.gpu)}{/if}</span>{/if}
        </p>
        <div class="row">{@render pauseButton()}</div>
        <p class="muted">
          A pause lasts until you resume it, here or from the Comfy-Gen tray icon, or until the agent restarts.
        </p>
        <p class="muted">The agent starts with your PC from now on. {choice === 'both' ? 'While the PC is off, Modal answers.' : ''}</p>
      {:else}
        <p class="muted">Waiting for your PC to connect…</p>
      {/if}
    {/if}
    {#if pcError}<p class="err">{pcError}</p>{/if}
  </Step>
{/if}

{#if choice === 'desktop'}
  <Step n={3} title="Install the Claude Desktop extension" status="current">
    <ol>
      <li>On the PC with the GPU, download <a href="{RELEASE}Comfy-Gen-MCP.mcpb">Comfy-Gen-MCP.mcpb</a> and open it: Claude Desktop installs it.</li>
      <li>The Comfy-Gen icon appears in the tray. Open its settings page from there, choose your GPU and install ComfyUI (a few minutes; it finds the models of ComfyUI installs you already have).</li>
      <li>Ask Claude Desktop for an image.</li>
    </ol>
    <p class="muted">
      This Worker is not needed for that. Keep it for later (it costs nothing idle): choose another option here to
      use claude.ai or the phone app too, or delete it from your Cloudflare dashboard.
    </p>
  </Step>
{/if}

{#if choice === 'url'}
  <Step n={num('url')} title="Connect your ComfyUI" status={status(gen?.kind === 'url')} summary={gen?.kind === 'url' ? gen.base_url : ''}>
    <form onsubmit={saveDirect}>
      <label for="url">ComfyUI URL</label>
      <input id="url" type="url" bind:value={directUrl} placeholder="https://comfy.example.com" />
      <p class="muted">It must be reachable from the internet. The Worker checks <code>/system_stats</code> before saving.</p>
      <button type="submit" disabled={directBusy || !directUrl.trim()}>{directBusy ? 'Checking…' : 'Use this ComfyUI'}</button>
      {#if directError}<p class="err">{directError}</p>{/if}
    </form>
  </Step>
{/if}

{#if choice !== 'desktop'}
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
{/if}

{#if info.claude_seen && choice !== 'desktop'}
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
        {gen?.kind === 'modal' ? 'redeploys ComfyUI on Modal too' : 'image requests keep working meanwhile'}.
      </p>
      {#if !updating && !(update.build && update.build === info.build)}
        <button onclick={updateNow} disabled={!update.can}>Update now</button>
        {#if !update.can}<p class="muted">Log in again with a Cloudflare token to update from here.</p>{/if}
      {/if}
    {:else}
      <p class="muted">
        This Worker runs {update.current}, the latest release. It checks for new ones every day.
      </p>
    {/if}
    {#if updateError}<p class="err">{updateError}</p>{/if}
    {#if update.build && (updating || (update.newer && update.build === info.build))}
      {#key update.build}
        <BuildLog
          onfinished={async () => {
            await refresh()
            await loadUpdate()
          }}
        />
      {/key}
      {#if updating && update && !update.newer}
        <p class="ok">Updated. <a href="/" onclick={() => location.reload()}>Reload this page</a> for the new version's settings page.</p>
      {/if}
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
