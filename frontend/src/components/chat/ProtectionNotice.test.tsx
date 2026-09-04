import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { ProtectionNotice } from './ProtectionNotice'
import type { Message } from '../../types'

afterEach(cleanup)

function message(protection?: string): Message {
  return {
    id: 'acct#INBOX#42',
    account_id: '',
    folder_id: '',
    thread_id: 't',
    from_name: 'Ana',
    from_addr: 'ana@example.com',
    to: '',
    subject: 'Figures',
    preview: '',
    body: '',
    date: 0,
    unread: false,
    starred: false,
    has_attachments: false,
    protection,
  } as Message
}

describe('what a message says was done to it', () => {
  it('says nothing about an ordinary message', () => {
    expect(render(<ProtectionNotice message={message()} />).container.textContent).toBe('')
    cleanup()
    expect(render(<ProtectionNotice message={message('none')} />).container.textContent).toBe('')
  })

  it('says an encrypted body is encrypted and offers to open it', () => {
    for (const kind of ['pgpEncrypted', 'pgpInline', 'smimeEnveloped']) {
      const view = render(<ProtectionNotice message={message(kind)} />)
      expect(view.container.textContent).toContain('Encrypted message')
      expect(view.container.textContent).toContain('Open it with your key')
      cleanup()
    }
  })

  it('does not offer to open one it has nowhere to fetch from', () => {
    // No account or folder means no message to go and get, and a button that
    // cannot work is worse than no button.
    const view = render(<ProtectionNotice message={message('pgpEncrypted')} />)
    expect(view.queryByText('Open it')).toBeNull()
  })

  it('calls an unchecked signature a claim rather than a fact', () => {
    // Before any verdict arrives — and for S/MIME, which cannot be checked
    // yet at all — the honest word is "claims".
    const view = render(<ProtectionNotice message={message('smimeSigned')} />)
    expect(view.container.textContent).toContain('claims a signature')
    expect(view.container.textContent).not.toContain('Verified')
  })

  it('does not go asking about a message with no account behind it', async () => {
    // The verdict needs a fetch; with nothing to fetch from, the claim stands
    // rather than an answer being invented.
    const view = render(<ProtectionNotice message={message('pgpSigned')} />)
    await waitFor(() => expect(view.container.textContent).toContain('claims a signature'))
    expect(view.container.textContent).toContain('has not checked it yet')
  })
})
