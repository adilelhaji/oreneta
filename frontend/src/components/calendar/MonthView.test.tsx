import { afterEach, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import i18n from '../../lib/i18n'
import { calendar$ } from '../../states/calendar'
import { MonthView } from './MonthView'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

it('updates weekday labels when the app language changes without navigating the month', async () => {
  calendar$.events.set([])
  calendar$.calendars.set([])
  calendar$.anchor.set(new Date(2026, 9, 5).getTime())
  const view = render(<MonthView onEventMenu={() => {}} />)
  expect(view.getByText('Mon')).toBeTruthy()
  await act(async () => {
    await i18n.changeLanguage('es')
  })
  expect(view.getByText('lun')).toBeTruthy()
  expect(view.queryByText('Mon')).toBeNull()
  expect(calendar$.anchor.peek()).toBe(new Date(2026, 9, 5).getTime())
})
