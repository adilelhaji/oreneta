import { afterEach, describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadTable, appliedListSort } from './ThreadTable'
import { mail$ } from '../../states/mail'
import { settings$ } from '../../states/settings'
import { ui$ } from '../../states/ui'

const render = (accountId = 'acc') =>
  renderToStaticMarkup(
    <ThreadTable
      accountId={accountId}
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
  ui$.filters.set([])
})

describe('appliedListSort', () => {
  it('keeps the chosen order where the core pages by conversation', () => {
    expect(appliedListSort({ key: 'sender', dir: 'asc' }, 'conversation-v1')).toEqual({ key: 'sender', dir: 'asc' })
  })

  it('reports newest first everywhere else, whatever was chosen', () => {
    expect(appliedListSort({ key: 'subject', dir: 'asc' }, '')).toEqual({ key: 'date', dir: 'desc' })
    expect(appliedListSort({ key: 'date', dir: 'asc' }, '')).toEqual({ key: 'date', dir: 'desc' })
  })

  it('claims no column for one account snoozed view, ordered by wake time', () => {
    expect(appliedListSort({ key: 'date', dir: 'desc' }, '', { snoozedByWakeTime: true })).toBeNull()
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

  it('marks no column on one account snoozed view, and says how it is ordered', () => {
    ui$.filters.set(['snoozed'])
    mail$.threadsPagination.set('')

    const html = render()

    for (const label of ['From', 'Subject', 'Date']) expect(sortOf(html, label)).toBe('none')
    expect(html).toContain('title="Snoozed conversations are listed by when they come back')
    // Merged across accounts, snoozed rows are newest first.
    expect(sortOf(render('unified'), 'Date')).toBe('descending')
  })
})
