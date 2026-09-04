import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { ProtectionNotice } from './ProtectionNotice'

afterEach(cleanup)

describe('what a message says was done to it', () => {
  it('says nothing about an ordinary message', () => {
    expect(render(<ProtectionNotice />).container.textContent).toBe('')
    cleanup()
    expect(render(<ProtectionNotice protection="none" />).container.textContent).toBe('')
  })

  it('explains why an encrypted body is not on screen', () => {
    for (const kind of ['pgpEncrypted', 'pgpInline', 'smimeEnveloped']) {
      const view = render(<ProtectionNotice protection={kind} />)
      expect(view.container.textContent).toContain('Encrypted message')
      expect(view.container.textContent).toContain('cannot decrypt it yet')
      cleanup()
    }
  })

  it('calls an unverified signature a claim and not a fact', () => {
    // The one mistake this must not make: saying "signed" for a signature
    // nothing has checked is what makes a forgery look authentic.
    for (const kind of ['pgpSigned', 'smimeSigned']) {
      const view = render(<ProtectionNotice protection={kind} />)
      expect(view.container.textContent).toContain('claims a signature')
      expect(view.container.textContent).toContain('has not checked it yet')
      expect(view.container.textContent).not.toContain('Verified')
      cleanup()
    }
  })
})
