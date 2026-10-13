import { useValue } from '@legendapp/state/react'
import { Shrink, Signature, TextQuote } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { settings$ } from '../../states/settings'
import { ToggleRow } from './AccountSettingsRows'

/**
 * Settings → Reading: folding quoted history and signatures, and fitting
 * fixed-width messages to the pane (ADR-0046, S01-07).
 */
export function ReaderFoldingRows() {
  const { t } = useTranslation()
  const foldQuotes = useValue(settings$.readerFoldQuotes)
  const foldSignatures = useValue(settings$.readerFoldSignatures)
  const fitWidth = useValue(settings$.readerFitWidth)

  return (
    <>
      <ToggleRow
        icon={<TextQuote size={16} strokeWidth={1.75} />}
        title={t('settings.reading.foldQuotes', { defaultValue: 'Fold quoted text' })}
        hint={t('settings.reading.foldQuotesHint', {
          defaultValue:
            'Earlier messages quoted at the end of a reply are tucked behind "Show quoted text". Forwards and replies written between the quoted lines stay open.',
        })}
        checked={foldQuotes}
        onChange={() => settings$.readerFoldQuotes.set(!foldQuotes)}
      />
      <ToggleRow
        icon={<Signature size={16} strokeWidth={1.75} />}
        title={t('settings.reading.foldSignatures', { defaultValue: 'Fold signatures' })}
        hint={t('settings.reading.foldSignaturesHint', {
          defaultValue: 'Signatures the sender\'s mail program marked as such are tucked behind "Show signature".',
        })}
        checked={foldSignatures}
        onChange={() => settings$.readerFoldSignatures.set(!foldSignatures)}
      />
      <ToggleRow
        icon={<Shrink size={16} strokeWidth={1.75} />}
        title={t('settings.reading.fitWidth', { defaultValue: 'Fit wide messages to the window' })}
        hint={t('settings.reading.fitWidthHint', {
          defaultValue:
            'Messages laid out wider than the reading pane are scaled down to fit it. Each message can also be switched from its menu.',
        })}
        checked={fitWidth}
        onChange={() => settings$.readerFitWidth.set(!fitWidth)}
      />
    </>
  )
}
