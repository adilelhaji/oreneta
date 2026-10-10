import { afterEach, describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadTable, appliedListSort } from './ThreadTable'
import { mail$ } from '../../states/mail'
import { settings$ } from '../../states/settings'

const render = () =>
  renderToStaticMarkup(
    <ThreadTable
      threads={[]}
      accounts={[]}
      selectedThread=""
      showAccount={false}
      onSelect={() => {}}
      onContextMenu={() => {}}
    />,
  )

const sortOf = (html: string, label: string) =>
  html.match(new RegExp(`<th scope="col" aria-sort="(\\w+)"[^>]*>(?:(?!</th>).)*>${label}<`))?.[1]

afterEach(() => {
  settings$.listSort.set({ key: 'date', dir: 'desc' })
  mail$.threadsPagination.set('')
})

describe('appliedListSort', () => {
  it('keeps the chosen order where the core pages by conversation', () => {
    expect(appliedListSort({ key: 'sender', dir: 'asc' }, 'conversation-v1')).toEqual({ key: 'sender', dir: 'asc' })
  })

  it('reports newest first everywhere else, whatever was chosen', () => {
    expect(appliedListSort({ key: 'subject', dir: 'asc' }, '')).toEqual({ key: 'date', dir: 'desc' })
    expect(appliedListSort({ key: 'date', dir: 'asc' }, '')).toEqual({ key: 'date', dir: 'desc' })
  })
})

describe('ThreadTable', () => {
  it('marks the chosen column on a conversation page', () => {
    settings$.listSort.set({ key: 'sender', dir: 'asc' })
    mail$.threadsPagination.set('conversation-v1')

    const html = render()

    expect(sortOf(html, 'From')).toBe('ascending')
    expect(sortOf(html, 'Date')).toBe('none')
    expect(html).not.toContain('title=')
  })

  it('marks the order the rows are really in when the view cannot honour the choice', () => {
    settings$.listSort.set({ key: 'sender', dir: 'asc' })
    mail$.threadsPagination.set('')

    const html = render()

    expect(sortOf(html, 'From')).toBe('none')
    expect(sortOf(html, 'Date')).toBe('descending')
    expect(html).toContain('title="This view is always shown newest first')
  })
})
