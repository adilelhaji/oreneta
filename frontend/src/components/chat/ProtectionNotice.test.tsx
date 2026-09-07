import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ProtectionNotice } from './ProtectionNotice'
import type { Message } from '../../types'

afterEach(() => {
  cleanup()
  delete (window as any).go
})

function message(protection?: string, over: Partial<Message> = {}): Message {
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
    ...over,
  } as Message
}

/** A message with somewhere to actually fetch the verdict from. */
function checkable(protection: string): Message {
  return message(protection, { account_id: 'acct', folder_id: 'INBOX' })
}

/** Stub the bridge call the notice's verify dispatch makes. */
function stubVerify(command: 'pgp.verify' | 'smime.verify', result: unknown) {
  ;(window as any).go = {
    main: { App: { Invoke: async (called: string) => (called === command ? result : {}) } },
  }
}

/** Stub the bridge and record which command "Open it" actually calls. */
function stubDecrypt(command: 'pgp.decrypt' | 'smime.decrypt', result: unknown) {
  const calls: string[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (called: string) => {
          calls.push(called)
          return called === command ? result : {}
        },
      },
    },
  }
  return calls
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
    // Before any verdict arrives, the honest word is "claims" — true for
    // every signed shape, PGP or S/MIME, detached or opaque.
    for (const kind of ['pgpSigned', 'smimeSigned', 'smimeOpaqueSigned']) {
      const view = render(<ProtectionNotice message={message(kind)} />)
      expect(view.container.textContent).toContain('claims a signature')
      expect(view.container.textContent).not.toContain('Verified')
      cleanup()
    }
  })

  it('does not go asking about a message with no account behind it', async () => {
    // The verdict needs a fetch; with nothing to fetch from, the claim stands
    // rather than an answer being invented.
    const view = render(<ProtectionNotice message={message('pgpSigned')} />)
    await waitFor(() => expect(view.container.textContent).toContain('claims a signature'))
    expect(view.container.textContent).toContain('has not checked it yet')
  })

  it('asks the S/MIME verifier for an S/MIME message, not the OpenPGP one', async () => {
    stubVerify('smime.verify', { verdict: 'good', fingerprint: 'AB', addresses: ['ana@example.com'] })
    const view = render(<ProtectionNotice message={checkable('smimeSigned')} />)
    await waitFor(() => expect(view.container.textContent).toContain('Signed by'))
  })

  it('reads Outlook-style opaque signing through the same verifier as detached', async () => {
    stubVerify('smime.verify', { verdict: 'good', fingerprint: 'AB', addresses: ['ana@example.com'] })
    const view = render(<ProtectionNotice message={checkable('smimeOpaqueSigned')} />)
    await waitFor(() => expect(view.container.textContent).toContain('Signed by'))
  })

  it('names the fifth verdict as its own thing, not good and not no-key', async () => {
    // The whole reason S/MIME needed a fifth verdict: the cryptography is
    // real, and nobody vouched for the certificate that made it.
    stubVerify('smime.verify', { verdict: 'validUntrusted', fingerprint: 'AB', addresses: ['ana@hospital.cat'] })
    const view = render(<ProtectionNotice message={checkable('smimeOpaqueSigned')} />)
    await waitFor(() => expect(view.container.textContent).toContain('not one you have confirmed'))
    expect(view.container.textContent).not.toContain('Verified')
  })

  it('treats a wrong signer as an alarm whether or not the certificate is trusted', async () => {
    stubVerify('smime.verify', {
      verdict: 'validUntrusted',
      fingerprint: 'AB',
      addresses: ['marc@example.com'],
      matchesSender: false,
    })
    const view = render(<ProtectionNotice message={checkable('smimeOpaqueSigned')} />)
    await waitFor(() => expect(view.container.textContent).toContain('Valid signature, but from somebody else'))
  })

  it('reports a bad S/MIME signature as tampered, not as unknown', async () => {
    stubVerify('smime.verify', { verdict: 'bad' })
    const view = render(<ProtectionNotice message={checkable('smimeSigned')} />)
    await waitFor(() => expect(view.container.textContent).toContain('Signature does not check out'))
  })

  it('opens an S/MIME-encrypted message through smime.decrypt, not pgp.decrypt', async () => {
    const calls = stubDecrypt('smime.decrypt', { ok: true, body: 'The figures are attached.' })
    const view = render(<ProtectionNotice message={checkable('smimeEnveloped')} />)
    fireEvent.click(view.getByText('Open it'))
    await waitFor(() => expect(view.container.textContent).toContain('The figures are attached.'))
    expect(calls).toContain('smime.decrypt')
    expect(calls).not.toContain('pgp.decrypt')
  })

  it('opens a PGP-encrypted message through pgp.decrypt, not smime.decrypt', async () => {
    const calls = stubDecrypt('pgp.decrypt', { ok: true, body: 'Lunch tomorrow?' })
    const view = render(<ProtectionNotice message={checkable('pgpEncrypted')} />)
    fireEvent.click(view.getByText('Open it'))
    await waitFor(() => expect(view.container.textContent).toContain('Lunch tomorrow?'))
    expect(calls).toContain('pgp.decrypt')
    expect(calls).not.toContain('smime.decrypt')
  })
})
