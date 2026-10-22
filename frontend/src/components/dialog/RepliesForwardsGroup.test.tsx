import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { RepliesForwardsGroup } from './RepliesForwardsGroup'
import { hydrateSettings, settings$ } from '../../states/settings'
import { DEFAULT_REPLY_FORWARD_PREFS } from '../../lib/replyForward'
import { settingsDestinations } from '../../lib/settingsDestinations'
import { filterCommands } from '../palette/paletteCommands'
import { t } from '../../lib/i18n'

const saves: { key: string; value: unknown }[] = []

beforeEach(() => {
  saves.length = 0
  settings$.replyForward.set(DEFAULT_REPLY_FORWARD_PREFS)
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
  settings$.replyForward.set(DEFAULT_REPLY_FORWARD_PREFS)
  delete (window as any).go
})

it('shows the defaults and persists each change as one reply_forward row', async () => {
  const screen = render(<RepliesForwardsGroup />)
  const include = screen.getByRole('switch', { name: 'Include the original message in replies' })
  expect(include.getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('switch', { name: 'Shorten “Re: Re:” to “Re:”' }).getAttribute('aria-checked')).toBe('true')

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Below the quote' })))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Plain text “>”' })))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Full header' })))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'As attachment' })))

  expect(settings$.replyForward.get()).toEqual({
    ...DEFAULT_REPLY_FORWARD_PREFS,
    replyPosition: 'below',
    quoteStyle: 'plain',
    headerStyle: 'outlook',
    forwardMode: 'attachment',
  })
  expect(saves.at(-1)).toEqual({ key: 'reply_forward', value: settings$.replyForward.get() })
  // Copying attachments only applies to an inline forward.
  expect(screen.queryByRole('switch', { name: 'Include the original’s attachments when forwarding' })).toBeNull()
})

it('hides the quoting choices when the original is left out', async () => {
  const screen = render(<RepliesForwardsGroup />)
  await act(async () =>
    fireEvent.click(screen.getByRole('switch', { name: 'Include the original message in replies' })),
  )
  expect(settings$.replyForward.get().includeOriginal).toBe(false)
  expect(screen.queryByRole('button', { name: 'Below the quote' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Full header' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Inline' })).toBeTruthy()
})

it('is a settings search destination', () => {
  for (const query of ['replies', 'forward', 'quote']) {
    const found = filterCommands(settingsDestinations([], t), query)
    expect(found.map((item) => item.id)).toContain('settings.section.repliesForwards')
  }
  const item = settingsDestinations([], t).find((entry) => entry.id === 'settings.section.repliesForwards')
  expect(item?.label).toBe('Replies and forwards')
  expect(item?.section).toBe('repliesForwards')
})

it('loads a stored row, defaulting fields it does not know', async () => {
  hydrateSettings({ reply_forward: { replyPosition: 'below', forwardMode: 'carrier-pigeon' } })
  expect(settings$.replyForward.get()).toEqual({ ...DEFAULT_REPLY_FORWARD_PREFS, replyPosition: 'below' })
  const screen = render(<RepliesForwardsGroup />)
  expect(screen.getByRole('button', { name: 'Below the quote' }).className).toContain('text-accent-fg')
  // Hydration does not echo the value back to the store.
  expect(saves.filter((save) => save.key === 'reply_forward')).toEqual([])
})
