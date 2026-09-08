import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { dismissSpamSuggestion, spamReason, type SpamVerdict } from '../../states/spam'
import { markThreadJunk } from '../../states/mail'
import type { Message } from '../../types'
import { Notice } from '../notice/Notice'

/**
 * What the learned spam filter thinks of this message, and why — fetched
 * only for a message the reader has flagged, the same "only when wondered
 * about" rule as `PriorityMenuSection`.
 *
 * Never files the message away on its own: the filter only ever suggests,
 * with the reason spelled out and a one-click way to act on it or dismiss
 * it. A wrong guess here must never bury mail nobody meant to hide, which is
 * the one failure this must not have.
 */
export function SpamNotice({ message }: { message: Message }) {
  const { t } = useTranslation()
  const [verdict, setVerdict] = useState<SpamVerdict | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setVerdict(null)
    setDismissed(false)
    if (!message.spam) return
    let live = true
    void spamReason(message.thread_id).then((result) => {
      if (live) setVerdict(result)
    })
    return () => {
      live = false
    }
  }, [message.thread_id, message.spam])

  if (!message.spam || !verdict?.spam || dismissed) return null

  const sender = verdict.sender || t('spam.reason.nothingKnown')
  const because = verdict.reasons
    .map((reason) => t(`spam.reason.${reason}`, { sender, defaultValue: reason }))
    .join(' · ')

  const moveToJunk = () => {
    setBusy(true)
    void markThreadJunk(message.thread_id, true).finally(() => setBusy(false))
  }

  const notSpam = () => {
    setDismissed(true)
    void dismissSpamSuggestion(message.thread_id)
  }

  return (
    <Notice
      tone="warning"
      className="mb-2"
      title={t('spam.suggestedTitle')}
      action={
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={moveToJunk}
            className="shrink-0 rounded-control bg-accent px-3 py-1 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer disabled:opacity-50"
          >
            {t('spam.moveToJunk')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={notSpam}
            className="shrink-0 rounded-control px-3 py-1 text-caption font-semibold text-secondary transition-colors hover:text-primary cursor-pointer disabled:opacity-50"
          >
            {t('spam.notSpam')}
          </button>
        </div>
      }
    >
      <span className="flex items-start gap-1.5">
        <ShieldAlert size={13} className="mt-0.5 shrink-0" />
        <span>{because}</span>
      </span>
    </Notice>
  )
}
