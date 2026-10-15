import { afterEach, beforeEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AccountDialogGraph } from './AccountDialogGraph'
import i18n from '../../lib/i18n'
import type { AccountDialogController } from './useAccountDialog'

// Only what the Graph panel reads from the dialog controller.
const ctl = {
  outlookConfigured: true,
  form: { display_name: '' },
  reconnectAccount: undefined,
} as unknown as AccountDialogController

function answerPollWith(error: string) {
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string) =>
          command === 'oauth.graphBegin'
            ? { attempt: 'attempt-1' }
            : command === 'oauth.graphPoll'
              ? { state: 'failed', error }
              : {},
      },
    },
  }
}

beforeEach(() => i18n.changeLanguage('en'))
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('says a refused app proxy is the cause instead of offering to sign in again (#201)', async () => {
  answerPollWith('app_proxy_unusable')
  const view = render(<AccountDialogGraph ctl={ctl} />)
  fireEvent.click(view.getByRole('button', { name: 'Sign in with Microsoft Graph' }))
  const alert = await waitFor(() => view.getByRole('alert'))
  expect(alert.textContent).toBe(
    'Setup did not finish: the app proxy setting is incomplete or cannot be used. Fix it in Settings → Network, then sign in again.',
  )
  expect(alert.textContent).not.toContain('app_proxy_unusable')
})

it("names the account's own proxy setting when that is the one refused", async () => {
  answerPollWith('account_proxy_unusable')
  const view = render(<AccountDialogGraph ctl={ctl} />)
  fireEvent.click(view.getByRole('button', { name: 'Sign in with Microsoft Graph' }))
  const alert = await waitFor(() => view.getByRole('alert'))
  expect(alert.textContent).toContain("this account's own proxy setting is incomplete or cannot be used")
})

it('keeps the generic failure for any other error', async () => {
  answerPollWith('denied')
  const view = render(<AccountDialogGraph ctl={ctl} />)
  fireEvent.click(view.getByRole('button', { name: 'Sign in with Microsoft Graph' }))
  const alert = await waitFor(() => view.getByRole('alert'))
  expect(alert.textContent).toContain('Setup did not finish. You can sign in again to retry. (denied)')
})
