// The setup site's walkthroughs: each <div data-guide="id [id…]"> becomes those guides from
// guides.json, walked as one. Its contents (the plain numbered steps) stay as they are without
// JavaScript, when guides.json doesn't load or a screenshot is missing.
//
// Every step is listed, always; Next moves which one is current (red) and the screenshot. Clicking
// a step goes to it. The setup wizard drives it: the element gets `tour` ({ next, prev, atStart,
// atEnd, hasShot }) and fires a bubbling `tourchange` after every change, and `tourchange` with
// `tour` gone when it falls back to the plain steps. Its own Back / Next stay for use outside the
// wizard (wizard.css hides them there).
import { concat, safe, stageAt, steps } from './tour-core.js'

const BASE = new URL('./', import.meta.url)
const guides = fetch(new URL('guides.json', BASE)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))

document.querySelectorAll('[data-guide]').forEach((el) => {
  guides.then((all) => {
    const guide = concat(all, el.dataset.guide.split(/\s+/))
    if (guide) mount(el, steps(guide))
  }).catch(() => {})
})

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function mount(el, items) {
  const fallback = el.innerHTML
  let at = 0
  let broken = false

  const changed = () => el.dispatchEvent(new CustomEvent('tourchange', { bubbles: true }))

  // The screenshot, with the markers so far and the current one's box.
  function shot() {
    const stage = stageAt(items, at)
    const view = stage?.view
    const src = view?.image && new URL(view.image, BASE).href
    return !src
      ? `<div class="tour-none">Screenshot coming: ${esc(view?.alt ?? '')}</div>`
      : `<a class="tour-shot" href="${esc(src)}" target="_blank" rel="noopener" title="Open full size">` +
        `<img src="${esc(src)}" alt="${esc(view.alt)}" width="${view.size[0]}" height="${view.size[1]}">` +
        stage.marks.map(({ n, current, mark }) =>
          (current && mark.box ? `<span class="tour-box" style="left:${mark.box[0]}%;top:${mark.box[1]}%;width:${mark.box[2]}%;height:${mark.box[3]}%"></span>` : '') +
          `<span class="tour-mark ${esc(mark.side)} ${current ? 'current' : 'done'}" style="left:${mark.x}%;top:${mark.y}%"><span>${n}</span></span>`).join('') +
        '</a>'
  }

  function render() {
    el.innerHTML = `<div class="tour-stage">${shot()}</div>` +
      '<ol class="tour-steps">' +
      items.map((it, i) => `<li data-i="${i}" class="${i < at ? 'done' : i === at ? 'current' : ''}">${safe(it.html)}</li>`).join('') + '</ol>' +
      '<div class="tour-nav">' +
      `<button type="button" class="tour-prev"${at > 0 ? '' : ' disabled'}>Back</button>` +
      `<span class="tour-count">Step ${at + 1} of ${items.length}</span>` +
      `<button type="button" class="tour-next">${at === items.length - 1 ? 'Start over' : 'Next'}</button>` +
      '</div>'
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
    if (broken || to < 0 || to >= items.length) return
    at = to
    render()
  }

  el.tour = {
    next: () => go(at + 1),
    prev: () => go(at - 1),
    atStart: () => at === 0,
    atEnd: () => at === items.length - 1,
    hasShot: () => Boolean(stageAt(items, at)?.view?.image),
  }
  el.classList.add('tour')
  el.tabIndex = 0
  el.addEventListener('click', (e) => {
    if (broken) return
    const li = e.target.closest('.tour-steps > li')
    if (li) return go(Number(li.dataset.i))
    const b = e.target.closest('button')
    if (!b) return
    const cls = b.className
    if (cls === 'tour-prev') go(at - 1)
    else if (cls === 'tour-next') go(at === items.length - 1 ? 0 : at + 1)
    else return
    // The buttons are drawn again: keep the focus on the one pressed.
    el.querySelector('button.' + cls)?.focus()
  })
  render()
}
