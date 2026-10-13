import { observable } from '@legendapp/state'
import { useValue } from '@legendapp/state/react'
import { settings$ } from './settings'

// Per-message "Fit to window" choices for this session (ADR-0046). A message
// with no entry follows the `readerFitWidth` setting; the message menu writes
// the opposite of whatever currently applies.
export const readerFitOverrides$ = observable<Record<string, boolean>>({})

export function isFitWidth(messageId: string): boolean {
  return readerFitOverrides$[messageId].peek() ?? settings$.readerFitWidth.peek()
}

export function toggleFitWidth(messageId: string) {
  readerFitOverrides$[messageId].set(!isFitWidth(messageId))
}

export function useFitWidth(messageId: string): boolean {
  const override = useValue(readerFitOverrides$[messageId])
  const setting = useValue(settings$.readerFitWidth)
  return override ?? setting
}
