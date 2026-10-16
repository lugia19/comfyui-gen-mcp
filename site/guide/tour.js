// The setup site's walkthroughs: each <div data-guide="id [id…]"> becomes those guides from
// guides.json, walked as one. Its contents (the plain numbered steps) stay as they are without
// JavaScript, when guides.json doesn't load or a screenshot is missing.
//
// The setup wizard drives it: the element gets `tour` ({ next, prev, atStart, atEnd }) and fires a
// bubbling `tourchange` after every change, and `tourchange` with `tour` gone when it falls back to
// the plain steps. Its own Back / Next stay for use outside the wizard (wizard.css hides them there).
import { concat, everything, next, number, prev, safe, shown, start, total } from './tour-core.js'

const BASE = new URL('./', import.meta.url)
const guides = fetch(new URL('guides.json', BASE)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))

document.querySelectorAll('[data-guide]').forEach((el) => {
  guides.then((all) => {
    const guide = concat(all, el.dataset.guide.split(/\s+/))
    if (guide) mount(el, guide)
  }).catch(() => {})
})

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function mount(el, guide) {
  const fallback = el.innerHTML
  let pos = start()
  let all = true // every step at once, each screenshot above its steps; "One step at a time" walks them
  let broken = false

  const changed = () => el.dispatchEvent(new CustomEvent('tourchange', { bubbles: true }))

  // One screenshot with its steps' markers (and the current ones' boxes).
  function shotOf(view, steps) {
    const src = view.image && new URL(view.image, BASE).href
    return !src
      ? `<div class="tour-none">Screenshot coming: ${esc(view.alt)}</div>`
      : `<a class="tour-shot" href="${esc(src)}" target="_blank" rel="noopener" title="Open full size">` +
        `<img src="${esc(src)}" alt="${esc(view.alt)}" width="${view.size[0]}" height="${view.size[1]}">` +
        steps.map(({ n, current, mark }) => !mark ? '' :
          (current && mark.box ? `<span class="tour-box" style="left:${mark.box[0]}%;top:${mark.box[1]}%;width:${mark.box[2]}%;height:${mark.box[3]}%"></span>` : '') +
          `<span class="tour-mark ${esc(mark.side)} ${current ? 'current' : 'done'}" style="left:${mark.x}%;top:${mark.y}%"><span>${n}</span></span>`).join('') +
        '</a>'
  }

  function render() {
    if (all) {
      el.innerHTML = everything(guide).map(({ view, steps }) =>
        `<div class="tour-stage">${shotOf(view, steps)}</div>` +
        `<ol class="tour-steps" start="${steps[0].n}">` + steps.map((s) => `<li>${safe(s.html)}</li>`).join('') + '</ol>').join('') +
        '<div class="tour-nav"><button type="button" class="tour-toggle">One step at a time</button></div>'
      afterRender()
      return
    }
    const view = guide.views[pos.v]
    const steps = shown(guide, pos)
    const end = !next(guide, pos)
    el.innerHTML = `<div class="tour-stage">${shotOf(view, steps)}</div>` +
      `<p class="wz-count">Step ${number(guide, pos)} of ${total(guide)}</p>` +
      `<ol class="tour-steps" start="${steps[0].n}">` +
      steps.map((s) => `<li class="${s.current ? 'current' : 'done'}">${safe(s.html)}</li>`).join('') + '</ol>' +
      '<div class="tour-nav">' +
      `<button type="button" class="tour-prev"${prev(guide, pos) ? '' : ' disabled'}>Back</button>` +
      `<span class="tour-count">Step ${number(guide, pos)} of ${total(guide)}</span>` +
      `<button type="button" class="tour-next">${end ? 'Start over' : 'Next'}</button>` +
      '<button type="button" class="tour-toggle">Show all steps</button>' +
      '</div>'
    afterRender()
  }

  function afterRender() {
    el.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => {
      // A missing screenshot: back to the plain steps.
      if (broken) return
      broken = true
      el.innerHTML = fallback
      el.classList.remove('tour')
      el.removeAttribute('tabindex')
      delete el.tour
      changed()
    }))
    changed()
  }

  function go(to) {
    if (!to || broken) return
    pos = to
    render()
  }

  el.tour = {
    next: () => go(next(guide, pos)),
    prev: () => go(prev(guide, pos)),
    atStart: () => all || !prev(guide, pos),
    atEnd: () => all || !next(guide, pos),
    hasShot: () => !all && Boolean(guide.views[pos.v].image), // all at once: the screenshots sit in the column
  }
  el.classList.add('tour')
  el.tabIndex = 0
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b || broken) return
    const cls = b.className
    if (cls === 'tour-prev') go(prev(guide, pos))
    else if (cls === 'tour-toggle') { all = !all; render() }
    else if (cls === 'tour-next') go(next(guide, pos) ?? start())
    else return
    // The buttons are drawn again: keep the focus on the one pressed.
    el.querySelector('button.' + cls)?.focus()
  })
  render()
}
