import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuickFilterBar } from './QuickFilterBar'
import { labels$ } from '../../states/labels'
import { ui$ } from '../../states/ui'
import type { Label } from '../../states/labels'

const label = (id: string, name: string, inBar: boolean, colour = '#2056dd'): Label => ({
  id,
  name,
  colour,
  inBar,
  links: {},
})

describe('QuickFilterBar', () => {
  it('renders an in-bar label as a chip, and leaves the rest in the dropdown', () => {
    labels$.labels.set([label('l-1', 'Urgent', true), label('l-2', 'Later', false)])
    ui$.filters.set([])

    const html = renderToStaticMarkup(<QuickFilterBar />)

    // The in-bar label is a clickable chip, tinted in its own colour.
    expect(html).toContain('color:#2056dd')
    expect(html).toContain('>Urgent</span>')
    // The other label only shows up as a <select> option, not a second chip.
    expect(html).toContain('<option value="l-2">Later</option>')
    expect(html).not.toContain('<option value="l-1">Urgent</option>')
  })

  it('marks the active label chip as pressed', () => {
    labels$.labels.set([label('l-1', 'Urgent', true)])
    ui$.filters.set(['label:l-1'])

    const html = renderToStaticMarkup(<QuickFilterBar />)

    // Nothing else in this scene is active, so this is the label chip.
    expect(html).toContain('aria-pressed="true"')
  })

  it('offers no dropdown at all once every label is a chip', () => {
    labels$.labels.set([label('l-1', 'Urgent', true)])
    ui$.filters.set([])

    const html = renderToStaticMarkup(<QuickFilterBar />)

    expect(html).not.toContain('<select')
  })

  it('offers no chips when no label is marked to show in the bar', () => {
    labels$.labels.set([label('l-1', 'Later', false)])
    ui$.filters.set([])

    const html = renderToStaticMarkup(<QuickFilterBar />)

    expect(html).toContain('<select')
    expect(html).not.toContain('>Later</span>')
  })
})
