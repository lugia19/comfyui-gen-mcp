// The walkthroughs' logic, shared by the setup site (tour.js) and the Worker's page (Tour.svelte):
// where Next and Prev go, which steps show, where the markers sit. No DOM here.
//
// A guide (site/guide/guides.json) is { views: [{ image, size: [w, h], alt, steps: [{ html, box?, at?, side? }] }] }.
// Coordinates are in the image's pixels: `box` [x, y, w, h] outlines the target, `at` [x, y] points
// at it without an outline, `side` is where the numbered badge sits (left, right, up, down). A view
// with `image: null` has no screenshot yet: its steps show as text.

// A position is { v, s }: view v, step s within it.
export const start = () => ({ v: 0, s: 0 })

export function next(guide, { v, s }) {
  if (s + 1 < guide.views[v].steps.length) return { v, s: s + 1 }
  if (v + 1 < guide.views.length) return { v: v + 1, s: 0 }
  return null
}

export function prev(guide, { v, s }) {
  if (s > 0) return { v, s: s - 1 }
  if (v > 0) return { v: v - 1, s: guide.views[v - 1].steps.length - 1 }
  return null
}

export const total = (guide) => guide.views.reduce((n, view) => n + view.steps.length, 0)

// The step's number across the guide, from 1.
export const number = (guide, { v, s }) => guide.views.slice(0, v).reduce((n, view) => n + view.steps.length, 0) + s + 1

// The current view's steps up to the current one, each with its number, `current` and its marker in
// percent of the image (null for a step without one).
export function shown(guide, pos) {
  const view = guide.views[pos.v]
  const first = number(guide, { v: pos.v, s: 0 })
  return view.steps.slice(0, pos.s + 1).map((step, i) => ({
    n: first + i,
    html: step.html,
    current: i === pos.s,
    mark: view.size ? marker(step, view.size) : null,
  }))
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
