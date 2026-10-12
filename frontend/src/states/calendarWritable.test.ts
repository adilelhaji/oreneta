import { expect, test } from 'bun:test'
import { writableCalendars, type Calendar } from './calendar'

const calendar = (id: string, patch: Partial<Calendar>): Calendar => ({
  id,
  name: id,
  is_default: false,
  enabled: true,
  kind: 'account',
  read_only: false,
  synced_at: 0,
  accountId: 'acc',
  ...patch,
})

test('a new event is offered only the calendars it can be saved to', () => {
  const offered = writableCalendars([
    calendar('work', {}),
    calendar('home', { kind: 'local' }),
    calendar('holidays', { kind: 'subscribed' }),
    calendar('shared', { read_only: true }),
    calendar('hidden', { enabled: false }),
  ]).map((entry) => entry.id)
  expect(offered).toEqual(['work', 'home'])
})
