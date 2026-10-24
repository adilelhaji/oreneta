import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { CompactNavigation } from './CompactNavigation'
import { AppMenuButton } from '../shell/AppMenu'
import { accounts$ } from '../../states/accounts'
import { ui$ } from '../../states/ui'

afterEach(() => {
  cleanup()
  accounts$.set([])
  ui$.module.set('mail')
})

// Below 769 px there is no module strip and no narrow bar (ADR-0068 §5).
// Owner decision 3 on #352: the «Més» menu goes; the way back stays, and the
// modules open from the band's app menu.
describe('compact workspace navigation (#354)', () => {
  it('keeps only the way back to mail, with no More menu of its own', () => {
    ui$.module.set('people')
    const view = render(<CompactNavigation />)
    expect(view.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.title)).toEqual([
      'Back to Chats',
    ])
    expect(view.queryByRole('button', { name: 'More' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Back to Chats' }))
    expect(ui$.module.peek()).toBe('mail')
  })

  it('leaves the modules to the app menu, which switches them and gives the focus back to its button', async () => {
    accounts$.set([
      {
        id: 'a',
        email: 'a@example.test',
        display_name: 'A',
        provider: 'imap',
        auth_type: 'password',
        imap_host: 'imap.example.test',
        imap_port: 993,
        smtp_host: 'smtp.example.test',
        smtp_port: 465,
        tls: true,
      },
    ])
    ui$.module.set('people')
    const view = render(
      <>
        <AppMenuButton />
        <CompactNavigation />
      </>,
    )
    const opener = view.getByRole('button', { name: 'App menu' })
    fireEvent.click(opener)
    const menu = view.getByRole('menu', { name: 'App menu' })
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Go to: Tasks' }))
    expect(ui$.module.peek()).toBe('tasks')
    expect(view.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(opener)
    // Escape closes it without changing the module.
    fireEvent.click(opener)
    fireEvent.keyDown(within(view.getByRole('menu', { name: 'App menu' })).getAllByRole('menuitemradio')[0], {
      key: 'Escape',
    })
    // The menu gives the focus back once it is gone.
    await act(async () => {})
    expect(view.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(ui$.module.peek()).toBe('tasks')
  })
})
