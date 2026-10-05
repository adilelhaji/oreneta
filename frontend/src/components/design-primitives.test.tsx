import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createRef } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Mail } from 'lucide-react'
import { Button } from './button/Button'
import { IconButton } from './button/IconButton'
import { Chip } from './chip/Chip'
import { TextInput } from './field/Field'
import { Notice } from './notice/Notice'
import { EmptyState } from './empty-state/EmptyState'
import { ErrorState, LoadingState } from './empty-state/StateViews'
import { DesignCatalogue } from './dialog/DesignCatalogue'
import { MenuItem } from './menu/MenuItem'

afterEach(() => {
  cleanup()
  delete (window as any).runtime
})

describe('shared control interactions', () => {
  it('keeps primary and icon controls inert when disabled and never submits implicitly', () => {
    const click = mock(() => {})
    const submit = mock((event: React.FormEvent) => event.preventDefault())
    const ref = createRef<HTMLButtonElement>()
    const view = render(
      <form onSubmit={submit}>
        <Button ref={ref} onClick={click} leftIcon={Mail}>
          Compose
        </Button>
        <Button disabled onClick={click}>
          Disabled
        </Button>
        <IconButton icon={Mail} label="Disabled icon" disabled onClick={click} />
      </form>,
    )
    fireEvent.click(view.getByRole('button', { name: 'Disabled' }))
    fireEvent.click(view.getByRole('button', { name: 'Disabled icon' }))
    expect(click).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Compose' }))
    expect(click).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()
    expect(ref.current === view.getByRole('button', { name: 'Compose' })).toBe(true)
    expect(view.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('exposes invalid inputs to assistive technology without dropping caller descriptions', () => {
    const view = render(<TextInput aria-label="Recipient" invalid aria-describedby="hint" />)
    const field = view.getByRole('textbox', { name: 'Recipient' })
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.getAttribute('aria-describedby')).toBe('hint')
    view.rerender(<TextInput aria-label="Recipient" aria-invalid="grammar" />)
    expect(field.getAttribute('aria-invalid')).toBe('grammar')
    view.rerender(<TextInput aria-label="Recipient" />)
    expect(field.hasAttribute('aria-invalid')).toBe(false)
  })

  it('keeps disabled menu actions inert and preserves long action names with shortcuts', () => {
    const click = mock(() => {})
    const view = render(
      <>
        <MenuItem label="Delete selected messages" danger disabled onClick={click} />
        <MenuItem label="Archive all reviewed messages" trailing={<kbd>Ctrl+E</kbd>} onClick={click} />
      </>,
    )
    fireEvent.click(view.getByRole('button', { name: 'Delete selected messages' }))
    expect(click).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Archive all reviewed messages Ctrl+E' }))
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('selects and removes a chip through distinct sibling controls', () => {
    const toggle = mock(() => {})
    const remove = mock(() => {})
    const parentClick = mock(() => {})
    const view = render(
      <div onClick={parentClick}>
        <Chip selected onClick={toggle} onRemove={remove} removeLabel="Remove work">
          Work
        </Chip>
      </div>,
    )
    expect(view.container.querySelector('button button')).toBeNull()
    const select = view.getByRole('button', { name: 'Work' })
    expect(select.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(view.getByRole('button', { name: 'Remove work' }))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(toggle).not.toHaveBeenCalled()
    expect(parentClick).not.toHaveBeenCalled()
    fireEvent.click(select)
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('preserves standalone toggle, static and removable-only chip semantics', () => {
    const toggle = mock(() => {})
    const remove = mock(() => {})
    const view = render(
      <>
        <Chip onClick={toggle}>Toggle</Chip>
        <Chip colour="#2056dd">Static</Chip>
        <Chip onRemove={remove} removeLabel="Remove recipient">
          Recipient
        </Chip>
      </>,
    )
    expect(view.getByRole('button', { name: 'Toggle' }).getAttribute('aria-pressed')).toBe('false')
    expect(view.getByText('Static').closest('button')).toBeNull()
    expect(view.getAllByRole('button')).toHaveLength(2)
    fireEvent.click(view.getByRole('button', { name: 'Toggle' }))
    fireEvent.click(view.getByRole('button', { name: 'Remove recipient' }))
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
  })
})

describe('shared feedback and catalogue', () => {
  it('keeps empty, loading and error distinguishable and retries only on user action', () => {
    const retry = mock(() => {})
    const view = render(
      <>
        <EmptyState title="Empty folder" text="No messages" />
        <LoadingState title="Loading mail" />
        <ErrorState title="Could not load" retryLabel="Retry" onRetry={retry} />
      </>,
    )
    expect(view.getByRole('status').textContent).toContain('Loading mail')
    expect(view.getByRole('alert').textContent).toContain('Could not load')
    expect(view.getByText('Empty folder').closest('[role]')).toBeNull()
    expect(retry).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('preserves notice urgency and the action while tones change', () => {
    const click = mock(() => {})
    const view = render(
      <Notice tone="success" title="Saved">
        Draft retained
      </Notice>,
    )
    expect(view.getByRole('status').textContent).toContain('Draft retained')
    view.rerender(
      <Notice tone="danger" action={<Button onClick={click}>Recover</Button>}>
        Unable to save
      </Notice>,
    )
    expect(view.getByRole('alert').textContent).toContain('Unable to save')
    fireEvent.click(view.getByRole('button', { name: 'Recover' }))
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('opens the approved art direction through the native helper and exercises removable states', () => {
    const open = mock(() => {})
    ;(window as any).runtime = { BrowserOpenURL: open }
    const view = render(<DesignCatalogue />)
    fireEvent.click(view.getByRole('button', { name: 'Art direction' }))
    expect(open).toHaveBeenCalledWith('https://github.com/adilelhaji/oreneta/blob/main/docs/design/art-direction.md')
    fireEvent.click(view.getByRole('button', { name: 'Remove selectable chip' }))
    expect(view.queryByRole('button', { name: 'Remove selectable chip' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Restore chip' }))
    expect(view.getByRole('button', { name: 'Remove selectable chip' })).toBeTruthy()
  })
})
