// The setup site's walkthroughs: each <div data-guide="id"> becomes the guide of that id from
// guides.json. Its contents (the plain numbered steps) stay as they are without JavaScript, when
// guides.json doesn't load or a screenshot is missing. Inside a step of the page's stepper, the last
// Next reads "Done, next" and moves the stepper on; elsewhere it starts over.
import { next, number, prev, safe, shown, start, total } from './tour-core.js'

const BASE = new URL('./', import.meta.url)
const guides = fetch(new URL('guides.json', BASE)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))

document.querySelectorAll('[data-guide]').forEach((el) => {
  guides.then((all) => all[el.dataset.guide] && mount(el, all[el.dataset.guide])).catch(() => {})
})

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function mount(el, guide) {
  const fallback = el.innerHTML
  const stepper = el.closest('.step')?.querySelector('button.next')
  let pos = start()
  let all = false
  let broken = false

  function render() {
    const view = guide.views[pos.v]
    const steps = shown(guide, pos)
    const end = !next(guide, pos)
    const src = view.image && new URL(view.image, BASE).href
    const shot = !src
      ? `<div class="tour-none">Screenshot coming: ${esc(view.alt)}</div>`
      : `<a class="tour-shot" href="${esc(src)}" target="_blank" rel="noopener" title="Open full size">` +
        `<img src="${esc(src)}" alt="${esc(view.alt)}" width="${view.size[0]}" height="${view.size[1]}">` +
        steps.map(({ n, current, mark }) => !mark ? '' :
          (current && mark.box ? `<span class="tour-box" style="left:${mark.box[0]}%;top:${mark.box[1]}%;width:${mark.box[2]}%;height:${mark.box[3]}%"></span>` : '') +
          `<span class="tour-mark ${esc(mark.side)} ${current ? 'current' : 'done'}" style="left:${mark.x}%;top:${mark.y}%"><span>${n}</span></span>`).join('') +
        '</a>'
    el.innerHTML = shot +
      `<ol class="tour-steps" start="${steps[0].n}">` +
      steps.map((s) => `<li class="${s.current ? 'current' : 'done'}">${safe(s.html)}</li>`).join('') + '</ol>' +
      '<div class="tour-nav">' +
      `<button type="button" class="tour-prev"${prev(guide, pos) ? '' : ' disabled'}>Back</button>` +
      `<span class="tour-count">Step ${number(guide, pos)} of ${total(guide)}</span>` +
      `<button type="button" class="tour-next">${end ? (stepper ? 'Done, next' : 'Start over') : 'Next'}</button>` +
      `<button type="button" class="tour-toggle">${all ? 'Hide' : 'Show'} all steps</button>` +
      '</div>' +
      (all ? '<ol class="tour-all">' + guide.views.flatMap((v) => v.steps).map((s) => `<li>${safe(s.html)}</li>`).join('') + '</ol>' : '')
    el.querySelector('img')?.addEventListener('error', () => {
      // A missing screenshot: back to the plain steps.
      broken = true
      el.innerHTML = fallback
      el.classList.remove('tour')
      el.removeAttribute('tabindex')
    })
  }

  function go(to) {
    if (!to || broken) return
    pos = to
    render()
  }

  el.classList.add('tour')
  el.tabIndex = 0
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b || broken) return
    const cls = b.className
    if (cls === 'tour-prev') go(prev(guide, pos))
    else if (cls === 'tour-toggle') { all = !all; render() }
    else if (cls === 'tour-next') {
      if (next(guide, pos)) go(next(guide, pos))
      else if (stepper) return stepper.click()
      else go(start())
    }
    // The buttons are drawn again: keep the focus on the one pressed (or Next, if it went away).
    const again = el.querySelector('button.' + cls)
    ;(again && !again.disabled ? again : el.querySelector('button.tour-next:not(:disabled)') || el).focus()
  })
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return
    if (e.key === 'ArrowRight') go(next(guide, pos))
    else if (e.key === 'ArrowLeft') go(prev(guide, pos))
    else return
    e.preventDefault()
  })
  render()
}
