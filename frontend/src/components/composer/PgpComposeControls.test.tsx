import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { PgpComposeControls } from './PgpComposeControls'
import { pgp$, secretKeys$ } from '../../states/pgp'

beforeEach(() => {
  pgp$.certs.set([])
  pgp$.loaded.set(true)
  secretKeys$.keys.set([])
  secretKeys$.loaded.set(true)
})
afterEach(cleanup)

function controls(over: Partial<Parameters<typeof PgpComposeControls>[0]> = {}) {
  return render(
    <PgpComposeControls
      sign={false}
      encrypt={false}
      passphrase=""
      onSignChange={() => undefined}
      onEncryptChange={() => undefined}
      onPassphraseChange={() => undefined}
      {...over}
    />,
  )
}

describe('sign and encrypt, offered where sending happens', () => {
  it('disables both when there is nothing to sign or encrypt with', () => {
    const view = controls()
    expect(view.getByTitle('Import your secret key to be able to sign').hasAttribute('disabled')).toBe(true)
    expect(view.getByTitle('Import the recipient’s certificate to be able to encrypt').hasAttribute('disabled')).toBe(true)
  })

  it('lets signing be turned on once a secret key exists', () => {
    secretKeys$.keys.set([
      { fingerprint: 'ABCD', userIds: ['Ana <ana@x.com>'], addresses: ['ana@x.com'], protected: false, addedAt: 0 },
    ])
    const view = controls()
    expect(view.getByTitle('Sign this message with your key').hasAttribute('disabled')).toBe(false)
  })

  it('lets encrypting be turned on once a certificate exists', () => {
    pgp$.certs.set([{ fingerprint: 'ABCD', userIds: ['Marc'], addresses: ['marc@x.com'], addedAt: 0 }])
    const view = controls()
    expect(view.getByTitle('Encrypt this message').hasAttribute('disabled')).toBe(false)
  })

  it('calls back when a toggle is clicked', () => {
    secretKeys$.keys.set([
      { fingerprint: 'ABCD', userIds: [], addresses: ['ana@x.com'], protected: false, addedAt: 0 },
    ])
    let signed = false
    const view = controls({ onSignChange: () => (signed = true) })
    fireEvent.click(view.getByTitle('Sign this message with your key'))
    expect(signed).toBe(true)
  })

  it('asks for a passphrase only when signing with a protected key and none was given', () => {
    secretKeys$.keys.set([
      { fingerprint: 'ABCD', userIds: [], addresses: ['ana@x.com'], protected: true, addedAt: 0 },
    ])
    const notSigning = controls()
    expect(notSigning.queryByPlaceholderText("Your key’s passphrase")).toBeNull()
    cleanup()
    const signing = controls({ sign: true })
    expect(signing.getByPlaceholderText("Your key’s passphrase")).toBeTruthy()
    cleanup()
    const filled = controls({ sign: true, passphrase: 'hunter2' })
    expect(filled.queryByPlaceholderText("Your key’s passphrase")).toBeNull()
  })

  it('does not ask for a passphrase when the key is not protected', () => {
    secretKeys$.keys.set([
      { fingerprint: 'ABCD', userIds: [], addresses: ['ana@x.com'], protected: false, addedAt: 0 },
    ])
    const view = controls({ sign: true })
    expect(view.queryByPlaceholderText("Your key’s passphrase")).toBeNull()
  })
})
