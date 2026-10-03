// The walkthroughs: tour-core.js's positions, and site/guide/guides.json against its screenshots.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { marker, next, number, prev, safe, shown, start, total } from '../../site/guide/tour-core.js'

const dir = new URL('../../site/guide/', import.meta.url)
const guides = JSON.parse(readFileSync(new URL('guides.json', dir), 'utf8'))

// Two views: two steps, then one.
const g = {
  views: [
    { image: 'a.png', size: [200, 100], steps: [{ html: 'one', box: [10, 20, 40, 10], side: 'left' }, { html: 'two', at: [100, 50], side: 'up' }] },
    { image: null, steps: [{ html: 'three' }] },
  ],
}

describe('tour positions', () => {
  it('walks forward across views and stops at the end', () => {
    const seen = []
    for (let p = start(); p; p = next(g, p)) seen.push([p.v, p.s, number(g, p)])
    expect(seen).toEqual([[0, 0, 1], [0, 1, 2], [1, 0, 3]])
    expect(total(g)).toBe(3)
  })

  it('walks back to the previous view’s last step', () => {
    expect(prev(g, { v: 1, s: 0 })).toEqual({ v: 0, s: 1 })
    expect(prev(g, { v: 0, s: 1 })).toEqual({ v: 0, s: 0 })
    expect(prev(g, start())).toBeNull()
  })

  it('shows the view’s steps up to the current one', () => {
    expect(shown(g, { v: 0, s: 0 }).map((s) => [s.n, s.current])).toEqual([[1, true]])
    expect(shown(g, { v: 0, s: 1 }).map((s) => [s.n, s.current])).toEqual([[1, false], [2, true]])
    expect(shown(g, { v: 1, s: 0 })).toEqual([{ n: 3, html: 'three', current: true, mark: null }])
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
