import { afterEach, beforeEach, expect, it, mock } from 'bun:test'

mock.module('../../boot', () => ({ boot: async () => {} }))

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AccountDialogCustom } from './AccountDialogCustom'
import { useAccountDialog } from './useAccountDialog'
import { dialogClasses } from './accountDialogStyles'
import { ui$ } from '../../states/ui'

const calls: { command: string; payload: any }[] = []

beforeEach(() => {
  calls.length = 0
  ui$.setupMode.set('custom')
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (command === 'account.autodiscover') {
            return {
              imap_host: 'imap.example.org',
              imap_port: 993,
              smtp_host: 'smtp.example.org',
              smtp_port: 465,
              username: payload.email,
              source: 'autoconfig',
            }
          }
          return {}
        },
      },
    },
  }
})

afterEach(() => {
  cleanup()
  delete (window as any).go
})

function Harness() {
  const ctl = useAccountDialog()
  return <AccountDialogCustom ctl={ctl} classes={dialogClasses(false)} isSetup={false} />
}

const lookups = () => calls.filter((c) => c.command === 'account.autodiscover')

it('typing the address and leaving the field contacts nothing', async () => {
  const screen = render(<Harness />)
  const email = screen.getByLabelText('Email Address') as HTMLInputElement
  await act(async () => {
    fireEvent.focus(email)
    fireEvent.change(email, { target: { value: 'ana@example.org' } })
    fireEvent.blur(email)
  })
  // Give any stray async lookup a chance to happen.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(lookups()).toEqual([])
})

it('looks the settings up only when Find settings is pressed, naming who is asked', async () => {
  const screen = render(<Harness />)
  const button = screen.getByRole('button', { name: /Find settings/ }) as HTMLButtonElement
  // Nothing to look up until there is an address.
  expect(button.disabled).toBe(true)

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'ana@example.org' } })
  })
  expect(button.disabled).toBe(false)
  const hint = document.getElementById(button.getAttribute('aria-describedby') ?? '')
  expect(hint?.textContent).toContain('example.org')
  expect(hint?.textContent).toContain('Mozilla')
  expect(lookups()).toEqual([])

  await act(async () => {
    fireEvent.click(button)
  })
  await waitFor(() =>
    expect(lookups()).toEqual([{ command: 'account.autodiscover', payload: { email: 'ana@example.org' } }]),
  )
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Server settings found'))
})

it('the servers can be entered by hand without any lookup', async () => {
  const screen = render(<Harness />)
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'ana@example.org' } })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced server settings' }))
  })
  const imapHost = screen.getByLabelText('IMAP Host') as HTMLInputElement
  await act(async () => {
    fireEvent.change(imapHost, { target: { value: 'mail.example.org' } })
    fireEvent.blur(imapHost)
  })
  expect(imapHost.value).toBe('mail.example.org')
  expect(lookups()).toEqual([])
})
