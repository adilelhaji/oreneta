import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ReaderTextSize } from '../src/components/chat/ReaderTextSize'
import { MessageRow } from '../src/components/chat/MessageRow'
import { MessageActions } from '../src/components/chat/MessageActions'
import { settings$ } from '../src/states/settings'
import { accounts$ } from '../src/states/accounts'
import { compose$ } from '../src/states/compose'
import { createFixture } from './fixtures'

const fixture = createFixture()
let previousScale: number
beforeEach(() => {
  previousScale = settings$.messageFontScale.peek()
  accounts$.set([structuredClone(fixture.account)])
  compose$.tabs.set([])
  compose$.activeTab.set('')
})
afterEach(() => {
  cleanup()
  settings$.messageFontScale.set(previousScale)
  compose$.tabs.set([])
  compose$.activeTab.set('')
})

describe('reader controls', () => {
  it('preserves a custom saved value and changes only the existing body scale', () => {
    settings$.messageFontScale.set(133)
    const uiScale = settings$.fontScale.peek()
    const view = render(<ReaderTextSize />)
    const select = view.getByRole('combobox', { name: 'Message text size' }) as HTMLSelectElement
    expect(select.value).toBe('133')
    for (const value of ['80', '400']) {
      fireEvent.change(select, { target: { value } })
      expect(settings$.messageFontScale.peek()).toBe(Number(value))
      expect(settings$.fontScale.peek()).toBe(uiScale)
    }
    fireEvent.change(select, { target: { value: '999' } })
    expect(settings$.messageFontScale.peek()).toBe(400)
    fireEvent.click(view.getByRole('button', { name: 'Reset to default' }))
    expect(settings$.messageFontScale.peek()).toBe(100)
    expect((view.getByRole('button', { name: 'Reset to default' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => settings$.messageFontScale.set(175))
    expect(select.value).toBe('175')
  })

  it('exposes native expand/collapse state and keeps action clicks separate', () => {
    const toggle = mock(() => {})
    const more = mock(() => {})
    const props = { message: fixture.messages[0], galleryOffset: 0, onToggleExpanded: toggle, onOpenContextMenu: more }
    const view = render(<MessageRow {...props} expanded={false} />)
    const expand = view.getByTitle('Expand message')
    expect(expand.tagName).toBe('BUTTON')
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expand)
    expect(toggle).toHaveBeenCalledTimes(1)
    view.rerender(<MessageRow {...props} expanded />)
    expect(view.getByTitle('Collapse message').getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(view.getByTitle('More message actions'))
    expect(more).toHaveBeenCalledTimes(1)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('button button')).toBeNull()
    expect(view.getByRole('group').getAttribute('aria-label')).toContain(fixture.messages[0].from_name)
  })

  it('forwards the chosen message through the existing composer without sending', async () => {
    const message = { ...fixture.messages[0], subject: 'Chosen message', body: 'Exact chosen body' }
    const view = render(
      <MessageActions
        message={message}
        isDraft={false}
        isRSS={false}
        onOpen={() => {}}
        onMore={() => {}}
        variant="inline"
      />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Forward' }))
    await waitFor(() => expect(compose$.tabs.peek()).toHaveLength(1))
    const draft = compose$.tabs.peek()[0].compose
    expect(draft?.subject).toContain('Chosen message')
    expect(draft?.text).toContain('Exact chosen body')
  })

  it('keeps Graph mutations disabled and omits forwarding for drafts and feeds', () => {
    accounts$.set([{ ...fixture.account, auth_type: 'graph_oauth', provider: 'outlook' }])
    const props = { message: fixture.messages[0], onOpen: () => {}, onMore: () => {}, variant: 'inline' as const }
    const view = render(<MessageActions {...props} isDraft={false} isRSS={false} />)
    const forward = view.getByRole('button', { name: 'Forward' }) as HTMLButtonElement
    expect(forward.disabled).toBe(true)
    fireEvent.click(forward)
    expect(compose$.tabs.peek()).toHaveLength(0)
    view.rerender(<MessageActions {...props} isDraft isRSS={false} />)
    expect(view.queryByRole('button', { name: 'Forward' })).toBeNull()
    view.rerender(<MessageActions {...props} isDraft={false} isRSS />)
    expect(view.queryByRole('button', { name: 'Forward' })).toBeNull()
  })
})
