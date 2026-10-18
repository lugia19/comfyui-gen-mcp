<script>
  import { api } from './api.js'
  import { Task } from './task.svelte.js'

  // Connect Modal (a Worker made by the setup site, path "oauth"): Modal's sign-in in a new tab;
  // this page waits for the approval, then deploys with the token it gave. The tab is opened at the
  // click (a tab opened after a request is often blocked). *small*: the button in a banner.
  let { refresh, small = false } = $props()

  const task = new Task()
  let waiting = $state(false)

  function connect() {
    const tab = window.open('about:blank', '_blank')
    task.run(async () => {
      const { url } = await api('POST', '/modal/connect')
      if (tab) tab.location.href = url
      else window.open(url, '_blank')
      waiting = true
      try {
        while (!(await api('POST', '/modal/connect/wait')).connected) {}
      } finally {
        waiting = false
      }
      await api('POST', '/setup/modal')
      await refresh()
    })
  }
</script>

<button class:small onclick={connect} disabled={task.busy}>{waiting ? 'Waiting for you to approve in Modal…' : task.busy ? 'Opening Modal…' : 'Connect Modal'}</button>
{#if task.error}<span class="err">{task.error}</span>{/if}
