import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { RecipientInput } from './RecipientInput'

afterEach(cleanup)

/** Renders the field and keeps its value the way the composer does. */
function field(initial: string) {
  let value = initial
  const view = render(
    <RecipientInput value={value} onChange={(next) => (value = next)} accountId="acc" placeholder="Recipients" />,
  )
  const rerender = () =>
    view.rerender(
      <RecipientInput value={value} onChange={(next) => (value = next)} accountId="acc" placeholder="Recipients" />,
    )
  return {
    view,
    input: () => view.container.querySelector('input')!,
    chips: () => Array.from(view.container.querySelectorAll('[class*="rounded-full"]')),
    value: () => value,
    rerender,
    type(text: string) {
      fireEvent.change(this.input(), { target: { value: text } })
      rerender()
    },
    press(key: string) {
      fireEvent.keyDown(this.input(), { key })
      rerender()
    },
  }
}

describe('the recipient field', () => {
  it('shows what is already there as chips', () => {
    const f = field('ana@example.com, marc@example.com, ')
    expect(f.view.container.textContent).toContain('ana@example.com')
    expect(f.view.container.textContent).toContain('marc@example.com')
  })

  it('shows a name rather than an address when it has one', () => {
    const f = field('Ana Prat <ana@example.com>, ')
    expect(f.view.container.textContent).toContain('Ana Prat')
  })

  it('leaves what is being typed in the input, not in a chip', () => {
    const f = field('ana@example.com, ma')
    expect(f.input().value).toBe('ma')
  })

  it('turns the typed address into a chip on a comma', () => {
    const f = field('')
    f.type('ana@example.com')
    f.press(',')
    expect(f.value()).toBe('ana@example.com, ')
    expect(f.input().value).toBe('')
  })

  it('does the same on Enter, which is what people press', () => {
    const f = field('')
    f.type('ana@example.com')
    f.press('Enter')
    expect(f.value()).toBe('ana@example.com, ')
  })

  it('does not make a chip out of nothing', () => {
    const f = field('')
    f.press('Enter')
    expect(f.value()).toBe('')
  })

  it('opens the last chip back up on backspace instead of deleting it', () => {
    const f = field('ana@example.com, marc@example.com, ')
    f.press('Backspace')
    expect(f.input().value).toBe('marc@example.com')
    expect(f.value()).toBe('ana@example.com, marc@example.com')
  })

  it('leaves an ordinary backspace alone while there is text to delete', () => {
    const f = field('ana@example.com, ma')
    f.press('Backspace')
    expect(f.value()).toBe('ana@example.com, ma')
  })

  it('removes a chip from its own button', () => {
    const f = field('ana@example.com, marc@example.com, ')
    fireEvent.click(f.view.getByLabelText('Remove ana@example.com'))
    expect(f.value()).toBe('marc@example.com, ')
  })

  it('takes a chip back apart when it is clicked', () => {
    const f = field('ana@example.com, marc@example.com, ')
    fireEvent.click(f.view.getByText('ana@example.com'))
    expect(f.value()).toBe('marc@example.com, ana@example.com')
  })

  it('marks an entry that cannot be an address', () => {
    const f = field('nonsense, ')
    const chip = f.view.getByTitle('This does not look like an email address.')
    expect(chip).toBeTruthy()
  })

  it('says nothing about an unusual but real address', () => {
    const f = field('root@localhost, ')
    expect(f.view.queryByTitle('This does not look like an email address.')).toBeNull()
  })

  it('turns a pasted list into several chips', () => {
    const f = field('')
    fireEvent.paste(f.input(), { clipboardData: { getData: () => 'a@x.com, b@x.com; c@x.com' } })
    f.rerender()
    expect(f.value()).toBe('a@x.com, b@x.com, c@x.com, ')
  })

  it('lets a single pasted address stay under the cursor', () => {
    const f = field('')
    fireEvent.paste(f.input(), { clipboardData: { getData: () => 'a@x.com' } })
    f.rerender()
    expect(f.value()).toBe('')
  })
})
