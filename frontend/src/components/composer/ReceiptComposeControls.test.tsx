import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ReceiptComposeControls } from './ReceiptComposeControls'
import { compose$, composedPayload, openComposeTab } from '../../states/compose'
import { accounts$ } from '../../states/accounts'
import { settings$ } from '../../states/settings'
import { ui$ } from '../../states/ui'

afterEach(cleanup)

describe('receipts, asked for where sending happens', () => {
  it('toggles each receipt on its own', () => {
    const changes: string[] = []
    const view = render(
      <ReceiptComposeControls
        read={false}
        delivery={true}
        onReadChange={(value) => changes.push(`read:${value}`)}
        onDeliveryChange={(value) => changes.push(`delivery:${value}`)}
      />,
    )
    const read = view.getByRole('button', { name: 'Request read receipt' })
    const delivery = view.getByRole('button', { name: 'Request delivery receipt' })
    expect(read.getAttribute('aria-pressed')).toBe('false')
    expect(delivery.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(read)
    fireEvent.click(delivery)
    expect(changes).toEqual(['read:true', 'delivery:false'])
  })

  it('puts a receipt in the send only when it was asked for', () => {
    const base = { accountId: 'acc-1', to: 'b@example.com', subject: 'Hi', rich: false, content: 'x', attachments: [] }
    const plain = composedPayload(base)
    expect('read_receipt' in plain).toBe(false)
    expect('delivery_receipt' in plain).toBe(false)
    const asked = composedPayload({ ...base, receipts: { read: true, delivery: true } })
    expect(asked).toMatchObject({ read_receipt: true, delivery_receipt: true })
    const readOnly = composedPayload({ ...base, receipts: { read: true, delivery: false } })
    expect(readOnly).toMatchObject({ read_receipt: true })
    expect('delivery_receipt' in readOnly).toBe(false)
  })
})

describe('receipt defaults in a new compose tab', () => {
  beforeEach(() => {
    compose$.tabs.set([])
    compose$.activeTab.set('')
    ui$.selectedAccount.set('acc-1')
    accounts$.set([
      {
        id: 'acc-1',
        email: 'me@example.com',
        display_name: 'Me',
        provider: 'custom',
        auth_type: 'password',
        imap_host: 'imap.example.com',
        imap_port: 993,
        smtp_host: 'smtp.example.com',
        smtp_port: 465,
        tls: true,
      } as any,
    ])
  })
  afterEach(() => {
    settings$.requestReadReceipt.set(false)
    settings$.requestDeliveryReceipt.set(false)
    compose$.tabs.set([])
  })

  const draftOf = (id: string | undefined) => compose$.tabs.get().find((tab) => tab.id === id)?.compose

  it('asks for nothing unless the settings say so', () => {
    expect(draftOf(openComposeTab())).toMatchObject({ readReceipt: false, deliveryReceipt: false })
  })

  it('starts from the defaults in settings', () => {
    settings$.requestReadReceipt.set(true)
    settings$.requestDeliveryReceipt.set(true)
    expect(draftOf(openComposeTab())).toMatchObject({ readReceipt: true, deliveryReceipt: true })
  })
})
