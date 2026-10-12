<script>
  // A few line icons, drawn in the text's color (inline SVG: no icon library). *name*: trash,
  // external, pause, play, link.
  let { name, size = 16 } = $props()
  const PATHS = {
    trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14', 'M10 11v6', 'M14 11v6'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    pause: ['M9 5v14', 'M15 5v14'],
    play: ['M7 5l12 7-12 7z'],
    link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2'],
  }
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#each PATHS[name] ?? [] as d (d)}<path {d} />{/each}
</svg>

<style>
  .icon {
    flex: none;
    vertical-align: -3px;
  }
</style>
