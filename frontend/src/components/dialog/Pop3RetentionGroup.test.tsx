import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Pop3RetentionGroup } from './Pop3RetentionGroup'
import { settleConfirm, ui$ } from '../../states/ui'

const calls: { command: string; payload: any }[] = []
let stored: any = { policy: 'keep' }

beforeEach(() => {
  calls.length = 0
  stored = { policy: 'keep' }
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          if (payload.retention) stored = payload.retention
          return stored
        },
      },
    },
  }
})
afterEach(() => {
  cleanup()
  delete (window as any).go
  ui$.confirm.set(null)
})

it('keeps mail on the server unless deleting is chosen and confirmed', async () => {
  const screen = render(<Pop3RetentionGroup accountId="pop" />)
  const select = (await waitFor(() => screen.getByLabelText('After downloading'))) as HTMLSelectElement
  expect(select.value).toBe('keep')

  await act(async () => {
    fireEvent.change(select, { target: { value: 'afterDays' } })
  })
  await waitFor(() => expect(ui$.confirm.get()?.message).toContain('14 days later'))
  await act(async () => settleConfirm(false))
  expect(calls.some((c) => c.payload.retention)).toBe(false)
  expect((screen.getByLabelText('After downloading') as HTMLSelectElement).value).toBe('keep')

  await act(async () => {
    fireEvent.change(screen.getByLabelText('After downloading'), { target: { value: 'whenDeletedHere' } })
  })
  await waitFor(() => expect(ui$.confirm.get()?.message).toContain('also be deleted from the server'))
  await act(async () => settleConfirm(true))
  await waitFor(() =>
    expect(calls.find((c) => c.payload.retention)?.payload).toEqual({
      account: 'pop',
      retention: { policy: 'whenDeletedHere' },
    }),
  )
  expect((screen.getByLabelText('After downloading') as HTMLSelectElement).value).toBe('whenDeletedHere')
})
