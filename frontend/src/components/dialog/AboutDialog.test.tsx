import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { AboutDialog } from './AboutDialog'
import { ui$ } from '../../states/ui'

const opened: string[] = []

beforeEach(() => {
  opened.length = 0
  ;(window as any).runtime = { BrowserOpenURL: (url: string) => opened.push(url) }
  ui$.aboutOpen.set(true)
})

afterEach(() => {
  cleanup()
  ui$.aboutOpen.set(false)
  delete (window as any).runtime
})

it('keeps the attribution to Meron but asks for no donations to the upstream project', () => {
  const screen = render(<AboutDialog />)
  expect(screen.getByText('Based on Meron by Nonbili Inc., under the AGPL-3.0 license.')).toBeTruthy()
  expect(screen.queryByText('Support development')).toBeNull()
  for (const name of ['GitHub', 'Liberapay', 'PayPal']) {
    expect(screen.queryByRole('button', { name })).toBeNull()
  }
  const html = document.body.innerHTML
  expect(html).not.toContain('sponsors/nonbili')
  expect(html).not.toContain('liberapay')
  expect(html).not.toContain('paypal')
})

it("opens Oreneta's own source code", async () => {
  const screen = render(<AboutDialog />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Source code' })))
  expect(opened).toEqual(['https://github.com/adilelhaji/oreneta'])
})
