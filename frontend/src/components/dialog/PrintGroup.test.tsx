import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { PrintGroup } from './PrintGroup'
import { hydrateSettings, settings$ } from '../../states/settings'
import { DEFAULT_PRINT_OPTIONS } from '../../lib/printOptions'
import { settingsDestinations } from '../../lib/settingsDestinations'
import { filterCommands } from '../palette/paletteCommands'
import { t } from '../../lib/i18n'

const saves: { key: string; value: unknown }[] = []

beforeEach(() => {
  settings$.print.set(structuredClone(DEFAULT_PRINT_OPTIONS))
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command === 'app.prefsSet') saves.push(payload)
          return { ok: true }
        },
      },
    },
  }
  saves.length = 0
})

afterEach(() => {
  cleanup()
  settings$.print.set(structuredClone(DEFAULT_PRINT_OPTIONS))
  delete (window as any).go
})

const SWITCHES = ['Print the subject', 'Print the date', 'Print the To line', 'Print the Cc line', 'Print the Bcc line']

it('names every control, shows the defaults and says the sender is always printed', () => {
  const screen = render(<PrintGroup />)
  expect(screen.getByRole('region', { name: 'Print' })).toBeTruthy()
  expect(SWITCHES.map((name) => screen.getByRole('switch', { name }).getAttribute('aria-checked'))).toEqual([
    'true',
    'true',
    'true',
    'true',
    'false',
  ])
  expect(screen.getByRole('switch', { name: 'List attachments' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText('Always printed')).toBeTruthy()
  const scope = screen.getByRole('group', { name: 'What to print' })
  expect(scope.querySelector('[aria-pressed="true"]')?.textContent).toBe('Whole conversation')
  const order = screen.getByRole('group', { name: 'Order' })
  expect(order.querySelector('[aria-pressed="true"]')?.textContent).toBe('Oldest first')
})

it('can be worked from the keyboard: every control is a focusable native button', () => {
  const screen = render(<PrintGroup />)
  const controls = [
    ...SWITCHES.map((name) => screen.getByRole('switch', { name })),
    screen.getByRole('switch', { name: 'List attachments' }),
    screen.getByRole('button', { name: 'Whole conversation' }),
    screen.getByRole('button', { name: 'One message' }),
    screen.getByRole('button', { name: 'Oldest first' }),
    screen.getByRole('button', { name: 'Newest first' }),
  ]
  for (const control of controls) {
    // A <button> takes Tab, Enter and Space from the browser itself.
    expect(control.tagName).toBe('BUTTON')
    expect(control.getAttribute('tabindex')).not.toBe('-1')
    expect((control as HTMLButtonElement).disabled).toBe(false)
    control.focus()
    expect(document.activeElement).toBe(control)
  }
})

it('persists each change as one print_options row', async () => {
  const screen = render(<PrintGroup />)
  await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Print the Cc line' })))
  await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Print the Bcc line' })))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Newest first' })))
  await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'List attachments' })))

  const expected = {
    ...DEFAULT_PRINT_OPTIONS,
    headers: { ...DEFAULT_PRINT_OPTIONS.headers, cc: false, bcc: true },
    order: 'newest',
    attachments: false,
  }
  expect(settings$.print.get()).toEqual(expected as never)
  expect(saves.at(-1)).toEqual({ key: 'print_options', value: expected })
  expect(screen.getByRole('switch', { name: 'Print the Cc line' }).getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('button', { name: 'Newest first' }).getAttribute('aria-pressed')).toBe('true')
  // The defaults themselves are untouched.
  expect(DEFAULT_PRINT_OPTIONS.headers.cc).toBe(true)
})

it('hides the order when one message is printed', async () => {
  const screen = render(<PrintGroup />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'One message' })))
  expect(settings$.print.get().scope).toBe('message')
  expect(saves.at(-1)?.key).toBe('print_options')
  expect(screen.queryByRole('group', { name: 'Order' })).toBeNull()
  expect(screen.getByRole('button', { name: 'One message' }).getAttribute('aria-pressed')).toBe('true')
})

it('remembers the choices: a stored row comes back on load, without being written again', () => {
  hydrateSettings({
    print_options: { headers: { date: false, bcc: true }, scope: 'message', order: 'sideways', attachments: false },
  })
  expect(settings$.print.get()).toEqual({
    headers: { ...DEFAULT_PRINT_OPTIONS.headers, date: false, bcc: true },
    scope: 'message',
    order: 'oldest',
    attachments: false,
  })
  const screen = render(<PrintGroup />)
  expect(screen.getByRole('switch', { name: 'Print the date' }).getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('switch', { name: 'Print the Bcc line' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('button', { name: 'One message' }).getAttribute('aria-pressed')).toBe('true')
  expect(saves.filter((save) => save.key === 'print_options')).toEqual([])
})

it('is a settings search destination', () => {
  for (const query of ['print', 'printer', 'bcc']) {
    const found = filterCommands(settingsDestinations([], t), query)
    expect(found.map((item) => item.id)).toContain('settings.section.print')
  }
  const item = settingsDestinations([], t).find((entry) => entry.id === 'settings.section.print')
  expect(item?.label).toBe('Print')
  expect(item?.section).toBe('print')
})
