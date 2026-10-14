<script>
  import Icon from './Icon.svelte'

  // A page the user has to visit, as a button that opens it in a new tab. *onopen*: told of the
  // click (a step that checks again when the user comes back).
  let { href, label, secondary = false, small = false, onopen = null } = $props()
</script>

<a class="button" class:secondary class:small {href} target="_blank" rel="noopener" onclick={() => onopen?.()}><Icon name="external" />{label}</a>
