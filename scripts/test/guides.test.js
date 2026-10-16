// The walkthroughs: tour-core.js's list and screenshot, and site/guide/guides.json against its screenshots.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { concat, marker, safe, stageAt, steps } from '../../site/guide/tour-core.js'

const dir = new URL('../../site/guide/', import.meta.url)
const guides = JSON.parse(readFileSync(new URL('guides.json', dir), 'utf8'))

// Two views: two steps, then one.
const g = {
  views: [
    { image: 'a.png', size: [200, 100], steps: [{ html: 'one', box: [10, 20, 40, 10], side: 'left' }, { html: 'two', at: [100, 50], side: 'up' }] },
    { image: null, steps: [{ html: 'three' }] },
  ],
}

describe('tour list', () => {
  it('lists a guide\'s steps across views, with their markers', () => {
    expect(steps(g).map((s) => [s.html, s.view === g.views[0], s.mark?.side ?? null])).toEqual([['one', true, 'left'], ['two', true, 'up'], ['three', false, null]])
  })

  it('shows the current step\'s view with its markers so far', () => {
    const items = steps(g)
    expect(stageAt(items, 0).marks.map((m) => [m.n, m.current])).toEqual([[1, true]])
    expect(stageAt(items, 1).marks.map((m) => [m.n, m.current])).toEqual([[1, false], [2, true]])
    expect(stageAt(items, 2)).toEqual({ view: g.views[1], marks: [] })
  })

  it("shows the page's own items beside the nearest view: the one before, else the one after", () => {
    const items = [{}, ...steps(g).slice(0, 2), {}]
    expect(stageAt(items, 0)).toEqual({ view: g.views[0], marks: [] }) // before any: the next, bare
    expect(stageAt(items, 2).marks.map((m) => m.n)).toEqual([2, 3]) // numbered by their place in the list
    expect(stageAt(items, 3).marks.map((m) => [m.n, m.current])).toEqual([[2, false], [3, false]]) // after: done
    expect(stageAt([{}, {}], 1)).toBeNull()
  })

  it('walks several guides as one, skipping missing ones', () => {
    const two = concat({ a: g, b: { views: [{ image: null, steps: [{ html: 'four' }] }] } }, ['a', 'missing', 'b'])
    expect(steps(two).map((s) => s.html)).toEqual(['one', 'two', 'three', 'four'])
    expect(concat({ a: g }, ['missing'])).toBeNull()
  })

  it('anchors the badge on the box edge it sits beside, in percent', () => {
    expect(marker(g.views[0].steps[0], [200, 100])).toEqual({ side: 'left', x: 5, y: 25, box: [5, 20, 20, 10] })
    expect(marker(g.views[0].steps[1], [200, 100])).toEqual({ side: 'up', x: 50, y: 50, box: null })
    expect(marker({ html: 'x' }, [200, 100])).toBeNull()
  })

  it('lets only <b>, <i> and <code> through', () => {
    expect(safe('Click <b>Add</b> &amp; <code>x</code>')).toBe('Click <b>Add</b> &amp; <code>x</code>')
    expect(safe('<img src=x onerror=alert(1)> & <a href="y">')).toBe('&lt;img src=x onerror=alert(1)&gt; &amp; &lt;a href="y"&gt;')
  })
})

describe('guides.json', () => {
  const views = Object.entries(guides).flatMap(([id, guide]) => guide.views.map((v, i) => [`${id} ${i + 1}`, v]))

  it.each(views)('%s: screenshot, size and markers fit', (_, view) => {
    expect(view.alt).toBeTruthy()
    expect(view.steps.length).toBeGreaterThan(0)
    if (view.image === null) {
      for (const step of view.steps) expect(step.box ?? step.at).toBeUndefined()
      return
    }
    expect(existsSync(new URL(view.image, dir))).toBe(true)
    const png = readFileSync(new URL(view.image, dir))
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual(view.size)
    const [w, h] = view.size
    for (const step of view.steps) {
      expect(safe(step.html)).toBe(step.html)
      if (!step.box && !step.at) continue
      expect(['left', 'right', 'up', 'down']).toContain(step.side)
      const m = marker(step, view.size)
      for (const v of [m.x, m.y]) expect(v >= 0 && v <= 100).toBe(true)
      if (step.box) {
        const [x, y, bw, bh] = step.box
        expect(x >= 0 && y >= 0 && x + bw <= w && y + bh <= h).toBe(true)
      }
    }
  })
})
