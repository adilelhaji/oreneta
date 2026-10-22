import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { runToastUndo, showToast, showUndoToast, ui$ } from './ui'

// Each toast keeps its own window: an older timer never clears a newer toast,
// even one with the same text (#321).

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  try {
    jest.advanceTimersByTime(10_000)
  } finally {
    jest.useRealTimers()
  }
  ui$.toast.set('')
  ui$.toastUndo.set(null)
})

describe('toast windows (#321)', () => {
  it('gives a repeated undo toast, and its undo, a full window of its own', () => {
    showUndoToast('Moved to junk', () => {})
    jest.advanceTimersByTime(3000)
    showUndoToast('Moved to junk', () => {})

    jest.advanceTimersByTime(2500)
    expect(ui$.toast.get()).toBe('Moved to junk')
    expect(ui$.toastUndo.peek()).toBeTruthy()

    jest.advanceTimersByTime(2500)
    expect(ui$.toast.get()).toBe('')
    expect(ui$.toastUndo.peek()).toBeNull()
  })

  it('gives a repeated plain toast a full window of its own', () => {
    showToast('Thread moved')
    jest.advanceTimersByTime(1500)
    showToast('Thread moved')

    jest.advanceTimersByTime(1000)
    expect(ui$.toast.get()).toBe('Thread moved')

    jest.advanceTimersByTime(1200)
    expect(ui$.toast.get()).toBe('')
  })

  it('does not cut a newer, different toast short', () => {
    showUndoToast('Moved to junk', () => {})
    jest.advanceTimersByTime(4000)
    showToast('Thread moved')

    jest.advanceTimersByTime(1500)
    expect(ui$.toast.get()).toBe('Thread moved')
  })

  it('keeps an older timer off a toast shown after an undo', () => {
    showUndoToast('Moved to junk', () => {})
    jest.advanceTimersByTime(1000)
    runToastUndo()
    showUndoToast('Moved to junk', () => {})

    jest.advanceTimersByTime(4500)
    expect(ui$.toast.get()).toBe('Moved to junk')
  })
})
