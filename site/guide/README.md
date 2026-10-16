The walkthroughs: step-by-step guides with numbered markers over screenshots, on the setup site
(`site/index.html`, through `tour.js`) and the Worker's pages (`web/src/lib/WalkGuide.svelte`, which loads
`guides.json` and the images from the published site). Both draw them the same way: `tour-core.js`
holds the logic, `tour.css` the look. Fixing a guide needs no release: the Worker's page picks up
`main` once Pages publishes it.

`guides.json` maps a guide's id to its views, each a screenshot and the steps on it:

```json
{ "r2": { "views": [ { "image": "r2-1-subscribe.png", "size": [1160, 470], "alt": "…",
  "steps": [ { "html": "Click <b>Add R2 subscription to my account</b>.", "box": [619, 27, 510, 35], "side": "left" } ] } ] } }
```

- Coordinates are the image's pixels: `box` [x, y, w, h] outlines the target, `at` [x, y] points at
  it without an outline, and `side` (left, right, up, down) is where the numbered badge sits.
  A step without either is text only.
- `size` is the image's width and height. `html` allows `<b>`, `<i>` and `<code>`; anything else
  shows as text.
- `"image": null` is a placeholder ("Screenshot coming"); no guide uses one now. To fill one in, add
  the PNG here and give the view its `image`, `size` and each step's `box` or `at` and `side`.
- Each guide's element keeps its plain steps inside, shown without JavaScript, when `guides.json`
  doesn't load, or when a screenshot is missing.
- Every step is listed, always; Next moves which one is current (red) and the screenshot. In the
  setup wizards (`wizard.css`) the screenshot is pinned to the left of the window and the wizard's
  Next walks the list: the site's `tour.js` puts `tour` (`next`, `prev`, `atStart`, `atEnd`,
  `hasShot`) on the element and fires `tourchange`; on the Worker a `WalkGuide`'s steps are items
  of the page's own list (`Walk.svelte`), which registers the same with its `Wizard`.
  `data-guide="a b"` (or `ids={['a', 'b']}`) walks several guides as one.
- `npm test` checks the file: every image exists at its `size`, every box fits, the text is allowed.

The screenshots come from the v1.9.0 dry run, cropped and with every private detail blurred (emails,
account and workspace names, token IDs, the claude.ai sidebar). Take new ones at about 1280 px wide;
blur the same kinds of details before adding them.
