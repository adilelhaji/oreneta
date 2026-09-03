import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TemplateMenu } from './TemplateMenu'
import { templates$, type Template } from '../../states/templates'

const snippet: Template = {
  id: 't1',
  kind: 'snippet',
  name: 'Directions',
  subject: '',
  bodyHtml: '',
  bodyText: 'Second floor.',
}

const message: Template = {
  id: 't2',
  kind: 'message',
  name: 'Weekly report',
  subject: 'Report',
  bodyHtml: '',
  bodyText: 'Here it is.',
}

beforeEach(() => {
  templates$.loaded.set(true)
  templates$.templates.set([])
})
afterEach(cleanup)

function open(picked: Template[] = []) {
  const view = render(<TemplateMenu onPick={(template) => picked.push(template)} />)
  fireEvent.click(view.getByLabelText('Insert saved text'))
  return view
}

describe('the menu of kept text', () => {
  it('says where to make some when there is none', () => {
    const view = open()
    expect(view.container.textContent).toContain('No saved text yet')
  })

  it('keeps the two shapes apart, because picking them does different things', () => {
    templates$.templates.set([snippet, message])
    const view = open()
    expect(view.container.textContent).toContain('Snippets')
    expect(view.container.textContent).toContain('Whole messages')
  })

  it('offers no heading for a shape nothing is kept in', () => {
    templates$.templates.set([snippet])
    const view = open()
    expect(view.container.textContent).not.toContain('Whole messages')
  })

  it('hands back the one that was picked', () => {
    templates$.templates.set([snippet, message])
    const picked: Template[] = []
    const view = open(picked)
    fireEvent.click(view.getByText('Weekly report'))
    expect(picked).toEqual([message])
  })

  it('closes once something is picked', () => {
    templates$.templates.set([snippet])
    const view = open()
    fireEvent.click(view.getByText('Directions'))
    expect(view.queryByText('Directions')).toBeNull()
  })

  it('offers a way to manage them even when there are none', () => {
    const view = open()
    expect(view.getByText('Manage saved text')).toBeTruthy()
  })
})
