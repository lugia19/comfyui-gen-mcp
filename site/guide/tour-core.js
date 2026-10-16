// The walkthroughs' logic, shared by the setup site (tour.js) and the Worker's pages (Walk.svelte):
// a guide's steps as list items, what the screenshot shows, where the markers sit. No DOM here.
//
// A guide (site/guide/guides.json) is { views: [{ image, size: [w, h], alt, steps: [{ html, box?, at?, side? }] }] }.
// Coordinates are in the image's pixels: `box` [x, y, w, h] outlines the target, `at` [x, y] points
// at it without an outline, `side` is where the numbered badge sits (left, right, up, down). A view
// with `image: null` has no screenshot yet: its steps show as text.

// Several guides walked as one (a wizard step with two, Modal's card then its token): their views
// in order. Guides missing from guides.json are skipped; none at all gives null.
export function concat(all, ids) {
  const views = ids.flatMap((id) => all[id]?.views ?? [])
  return views.length ? { views } : null
}

// A guide's steps as items of one list: [{ view, html, mark }], the marker in percent of the image
// (null for a step without one). A step's number is its place in the page's list.
export const steps = (guide) =>
  guide.views.flatMap((view) => view.steps.map((step) => ({ view, html: step.html, mark: view.size ? marker(step, view.size) : null })))

// What the screenshot shows while item *at* of a list is current, where some items are walkthrough
// steps ({ view, mark }) and others the page's own (no view): the current step's view with its
// markers so far, the current one boxed; for one of the page's items, the view before it with its
// markers done, else the one after it, bare; null when the list has none.
// { view, marks: [{ n, mark, current }] }.
export function stageAt(items, at) {
  const marks = (view, upTo, cur) =>
    items.flatMap((it, i) => (it.view === view && it.mark && i <= upTo ? [{ n: i + 1, mark: it.mark, current: i === cur }] : []))
  if (items[at]?.view) return { view: items[at].view, marks: marks(items[at].view, at, at) }
  for (let i = at - 1; i >= 0; i--) if (items[i].view) return { view: items[i].view, marks: marks(items[i].view, at, -1) }
  for (let i = at + 1; i < items.length; i++) if (items[i].view) return { view: items[i].view, marks: [] }
  return null
}

// The badge's anchor: the middle of the box's edge on the badge's side, or `at`.
export function marker(step, [w, h]) {
  if (!step.box && !step.at) return null
  let x, y
  if (step.at) [x, y] = step.at
  else {
    const [bx, by, bw, bh] = step.box
    ;[x, y] = { left: [bx, by + bh / 2], right: [bx + bw, by + bh / 2], up: [bx + bw / 2, by], down: [bx + bw / 2, by + bh] }[step.side]
  }
  const pct = (a, of) => Math.round((a / of) * 10000) / 100
  return {
    side: step.side,
    x: pct(x, w),
    y: pct(y, h),
    box: step.box ? [pct(step.box[0], w), pct(step.box[1], h), pct(step.box[2], w), pct(step.box[3], h)] : null,
  }
}

// The steps' text allows <b>, <i> and <code> only: everything else is shown as text.
export function safe(html) {
  return html
    .replace(/&(?!(amp|lt|gt|quot|#\d+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;(\/?)(b|i|code)&gt;/g, '<$1$2>')
}
