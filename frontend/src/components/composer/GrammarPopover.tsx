import { useEffect, useRef } from 'react'
import type { Editor } from '@tiptap/core'
import { useTranslation } from '../../lib/i18n'
import type { GrammarChecker, GrammarResult } from '../../lib/grammar'
import { applySuggestion, grammarKey, type PlacedIssue } from './grammarExtension'
import { menuLeft } from '../../lib/direction'

/**
 * One grammar issue the writer clicked (#105): what Harper says, its
 * suggestions, and "ignore". Picking one is a single undoable edit.
 */
export function GrammarPopover({
  editor,
  checker,
  pick,
  onClose,
}: {
  editor: Editor
  checker: GrammarChecker
  pick: { placed: PlacedIssue; at: { left: number; top: number } }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const { placed, at } = pick

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', escape)
    }
  }, [onClose])

  const apply = (replacement: string) => {
    applySuggestion(editor.view, placed, replacement)
    onClose()
    editor.commands.focus()
  }

  const ignore = () => {
    checker.ignore(placed.issue)
    const remaining = (grammarKey.getState(editor.state)?.placed ?? []).filter((p) => p.issue.key !== placed.issue.key)
    editor.view.dispatch(editor.state.tr.setMeta(grammarKey, { placed: remaining }))
    onClose()
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('grammar.label', { defaultValue: 'Grammar suggestion' })}
      className="fixed z-50 w-72 rounded-control border border-border bg-chats p-2.5 text-caption shadow-overlay"
      // Opens from the caret towards the end of the line (ADR-0061).
      style={{ left: menuLeft(at.left, 300, window.innerWidth, 0), top: at.top + 4 }}
    >
      <p className="text-primary">{placed.issue.message}</p>
      {placed.issue.suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {placed.issue.suggestions.slice(0, 5).map((suggestion, index) => (
            <button
              key={index}
              type="button"
              onClick={() => apply(suggestion)}
              className="rounded-control-sm bg-accent/12 px-2 py-1 font-semibold text-accent-fg hover:bg-accent/20 cursor-pointer"
            >
              {suggestion === '' ? t('grammar.remove', { defaultValue: 'Remove it' }) : suggestion}
            </button>
          ))}
        </div>
      )}
      <button type="button" onClick={ignore} className="mt-2 text-secondary underline cursor-pointer">
        {t('grammar.ignore', { defaultValue: 'Ignore' })}
      </button>
    </div>
  )
}

/** One quiet line under the editor when grammar was not checked, and why. */
export function GrammarStatus({ result, error }: { result: GrammarResult | null; error: string }) {
  const { t } = useTranslation()
  const text = error
    ? t('grammar.failed', { reason: error, defaultValue: 'Grammar suggestions could not start: {reason}' })
    : result?.state === 'notEnglish'
      ? t('grammar.notEnglish', {
          defaultValue: 'Grammar is checked in English only, and this text does not read as English.',
        })
      : result?.state === 'tooLong'
        ? t('grammar.tooLong', {
            limit: result.limit,
            defaultValue: 'Too long to check grammar (over {limit} characters).',
          })
        : ''
  if (!text) return null
  return <p className="px-1 pt-1 text-2xs text-secondary">{text}</p>
}
