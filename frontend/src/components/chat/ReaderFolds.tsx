import { useMemo, useState, type ReactNode } from 'react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { settings$ } from '../../states/settings'
import { splitPlainText, type FoldKind, type FoldLabels, type FoldOptions } from './quoteFolding'

/** What the reader folds, from Settings → Reading (ADR-0046). */
export function useFoldOptions(): FoldOptions {
  const quotes = useValue(settings$.readerFoldQuotes)
  const signatures = useValue(settings$.readerFoldSignatures)
  return useMemo(() => ({ quotes, signatures }), [quotes, signatures])
}

export function useFoldLabels(): FoldLabels {
  const { t } = useTranslation()
  return useMemo(
    () => ({
      showQuoted: t('reader.fold.showQuoted', { defaultValue: 'Show quoted text' }),
      hideQuoted: t('reader.fold.hideQuoted', { defaultValue: 'Hide quoted text' }),
      showSignature: t('reader.fold.showSignature', { defaultValue: 'Show signature' }),
      hideSignature: t('reader.fold.hideSignature', { defaultValue: 'Hide signature' }),
    }),
    [t],
  )
}

function FoldToggle({
  kind,
  open,
  labels,
  onToggle,
}: {
  kind: FoldKind
  open: boolean
  labels: FoldLabels
  onToggle: () => void
}) {
  const label =
    kind === 'quote'
      ? open
        ? labels.hideQuoted
        : labels.showQuoted
      : open
        ? labels.hideSignature
        : labels.showSignature
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="my-1 inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-px font-sans text-2xs font-normal not-italic tracking-normal text-secondary whitespace-nowrap hover:border-accent/40 hover:text-primary cursor-pointer"
    >
      <span aria-hidden="true" className="tracking-[1px]">
        •••
      </span>
      {label}
    </button>
  )
}

/**
 * A plain-text body with its trailing quote (and, when asked, its signature)
 * folded behind toggles. `render` draws a run of text the way the caller draws
 * any body text (links, code fences, search marks). A fold holding a search hit
 * starts open, so a match is never hidden.
 */
export function PlainFoldedText({
  text,
  render,
  searchQuery = '',
}: {
  text: string
  render: (text: string, keyPrefix: string) => ReactNode
  searchQuery?: string
}) {
  const options = useFoldOptions()
  const labels = useFoldLabels()
  const segments = useMemo(() => splitPlainText(text, options), [text, options])
  const [toggled, setToggled] = useState<Record<number, boolean>>({})

  if (segments.length === 1) return <>{render(text, 'body')}</>

  const needle = searchQuery.trim().toLowerCase()
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'body') {
          return <div key={index}>{render(segment.text.replace(/\s+$/, ''), `body-${index}`)}</div>
        }
        const hit = !!needle && segment.text.toLowerCase().includes(needle)
        const open = toggled[index] ?? hit
        return (
          <div key={index} data-reader-fold={segment.kind}>
            <FoldToggle
              kind={segment.kind}
              open={open}
              labels={labels}
              onToggle={() => setToggled((current) => ({ ...current, [index]: !open }))}
            />
            {open && <div>{render(segment.text.replace(/^\s+|\s+$/g, ''), `fold-${index}`)}</div>}
          </div>
        )
      })}
    </>
  )
}
