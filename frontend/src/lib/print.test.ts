import { afterEach, describe, expect, it } from 'bun:test'
import { printConversation } from './print'

afterEach(() => {
  for (const frame of document.querySelectorAll('iframe')) frame.remove()
})

describe('the print frame (#35)', () => {
  it('runs no script: sandboxed without allow-scripts', () => {
    void printConversation({
      subject: 'Lunch',
      messages: [],
      printedLabel: 'Printed',
      toLabel: 'To',
      ccLabel: 'Cc',
      attachmentsLabel: 'Attachments',
    })
    const frame = document.querySelector('iframe')!
    const sandbox = frame.getAttribute('sandbox')
    expect(sandbox).not.toBeNull()
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).toContain('allow-modals')
  })
})
