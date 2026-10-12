import { afterEach, expect, it } from 'bun:test'
import { decryptSmimeMessage } from './smime'

afterEach(() => {
  delete (window as any).go
})

const answer = (value: unknown) => {
  ;(window as any).go = { main: { App: { Invoke: async () => value } } }
}

it('names an algorithm it does not implement, in the shape OpenPGP uses (#49)', async () => {
  answer({ ok: false, failure: { reason: 'unsupported', algorithm: 'RSAES-OAEP key transport' } })
  expect(await decryptSmimeMessage('a', 'INBOX', 1)).toEqual({
    ok: false,
    failure: { reason: 'unsupported', detail: 'RSAES-OAEP key transport' },
  })
  answer({ ok: false, failure: { reason: 'noKey' } })
  expect(await decryptSmimeMessage('a', 'INBOX', 1)).toEqual({ ok: false, failure: { reason: 'noKey' } })
})
