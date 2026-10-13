import { useEffect, useState } from 'react'
import { MailCheck } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { showToast } from '../../states/ui'
import type { Message } from '../../types'

/** Where a message's read receipt request stands, as the core answers it. */
export type ReceiptStatus = {
  state: 'none' | 'ask' | 'sent' | 'declined' | 'silent'
  caution?: 'mailingList' | 'addressMismatch'
  silence?: 'never' | 'junk' | 'unidentified'
  to: string[]
  automatic: boolean
}

/**
 * A message that asks to be told it was read (ADR-0048).
 *
 * The core decides: it remembers each answer, never answers Junk, and sends
 * on its own only under the person's "always" and only where that is safe.
 * This bar is the "ask" case: a non-blocking question, answered once. Doing
 * nothing sends nothing.
 */
export function ReceiptNotice({ message }: { message: Message }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ReceiptStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setStatus(null)
    invoke<ReceiptStatus>('receipts.status', { id: message.id, folder: message.folder_id }).then(
      (answer) => {
        if (live) setStatus(answer)
      },
      () => {
        if (live) setStatus(null)
      },
    )
    return () => {
      live = false
    }
  }, [message.id, message.folder_id])

  if (!status) return null

  if (status.state === 'sent') {
    return (
      <p className="mb-2 flex items-center gap-1.5 text-caption text-secondary">
        <MailCheck size={14} strokeWidth={1.75} aria-hidden="true" />
        {status.automatic
          ? t('receipts.sentAutomatically', { defaultValue: 'A read receipt was sent, as your settings ask.' })
          : t('receipts.sent', { defaultValue: 'A read receipt was sent.' })}
      </p>
    )
  }
  if (status.state !== 'ask') return null

  const answer = async (send: boolean) => {
    setBusy(true)
    try {
      setStatus(await invoke<ReceiptStatus>('receipts.answer', { id: message.id, folder: message.folder_id, send }))
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const caution =
    status.caution === 'mailingList'
      ? t('receipts.cautionList', {
          defaultValue: 'This came through a mailing list, so the receipt may reach more than the sender.',
        })
      : status.caution === 'addressMismatch'
        ? t('receipts.cautionAddress', {
            defaultValue: 'The receipt would go to {address}, not where the message came from.',
            address: status.to.join(', '),
          })
        : ''

  return (
    <div
      role="group"
      aria-label={t('receipts.requestedLabel', { defaultValue: 'Read receipt requested' })}
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control-sm border border-border/60 bg-black/[0.02] px-3 py-2 text-caption text-secondary dark:bg-white/[0.02]"
    >
      <MailCheck size={14} strokeWidth={1.75} aria-hidden="true" className="text-accent" />
      <span className="min-w-0 flex-1">
        {t('receipts.asked', { defaultValue: 'The sender asked to be told when you read this.' })}
        {caution && <span className="block">{caution}</span>}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void answer(true)}
        className="font-semibold text-accent underline cursor-pointer disabled:opacity-50"
      >
        {t('receipts.send', { defaultValue: 'Send receipt' })}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void answer(false)}
        className="text-secondary underline cursor-pointer hover:text-primary disabled:opacity-50"
      >
        {t('receipts.dontSend', { defaultValue: 'Don’t send' })}
      </button>
    </div>
  )
}
