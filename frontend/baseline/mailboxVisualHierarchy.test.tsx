import { afterEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ThreadTable } from '../src/components/threads/ThreadTable'
import { createFixture } from './fixtures'

afterEach(cleanup)

it('keeps unread, opening and bulk selection independent across read-state updates', () => {
  const fixture = createFixture()
  let opens = 0
  let toggles = 0
  const props = {
    accounts: [fixture.account],
    threads: [fixture.threads[0]],
    selectedThread: fixture.threads[0].thread_id,
    showAccount: false,
    isBulkSelected: () => true,
    onSelect: () => {
      opens++
    },
    onToggleSelect: () => {
      toggles++
    },
    onContextMenu: () => {},
  }
  const view = render(<ThreadTable {...props} />)
  const row = view.container.querySelector('tbody tr')!
  const subject = view.getByRole('button', { name: /Unread: Pilot checklist/ })
  expect(row.getAttribute('data-unread')).toBe('true')
  expect(row.getAttribute('data-opened')).toBe('true')
  expect(row.getAttribute('data-bulk-selected')).toBe('true')
  expect(subject.getAttribute('aria-current')).toBe('true')
  expect(subject.querySelector('[data-unread-marker]')?.getAttribute('aria-hidden')).toBe('true')
  fireEvent.click(view.getByRole('checkbox'))
  expect(toggles).toBe(1)
  expect(opens).toBe(0)
  view.rerender(<ThreadTable {...props} threads={[{ ...props.threads[0], unread: false }]} />)
  expect(row.hasAttribute('data-unread')).toBe(false)
  expect(view.queryByRole('button', { name: /Unread:/ })).toBeNull()
  expect(row.getAttribute('data-opened')).toBe('true')
  expect(row.getAttribute('data-bulk-selected')).toBe('true')
  expect(row.querySelectorAll('[data-unread-marker]')).toHaveLength(1)
  fireEvent.click(view.getByRole('button', { name: /Pilot checklist/ }))
  expect(opens).toBe(1)
  expect(toggles).toBe(1)
})
