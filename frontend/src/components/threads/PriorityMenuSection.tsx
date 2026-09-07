import { useEffect, useState } from 'react'
import { Sparkle, Wind } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { priorityReason, setSenderPriority, type PriorityVerdict } from '../../states/priority'
import { ui$ } from '../../states/ui'
import { MenuItem } from '../menu/MenuItem'

/**
 * Why this conversation is where the priority filter put it, and how to say
 * otherwise.
 *
 * The reason is fetched when the menu opens, not carried on every row: it is
 * only wanted when someone wonders, and fifty of them computed to show none
 * would be work nobody asked for. Until it arrives the section is simply not
 * there — a placeholder saying "why?" with nothing behind it is worse than
 * waiting a moment.
 *
 * Both choices are offered whichever way the verdict went, and the one already
 * in force reads as "decide by the usual signals" instead — so taking a
 * decision back is as easy as making it, and does not mean pushing it the
 * other way.
 */
export function PriorityMenuSection({
  threadId,
  accountId,
  folderId,
  onAct,
}: {
  threadId: string
  accountId: string
  folderId: string
  /** Closes the menu; the caller owns that. */
  onAct: () => void
}) {
  const { t } = useTranslation()
  const [verdict, setVerdict] = useState<PriorityVerdict | null>(null)

  useEffect(() => {
    let live = true
    void priorityReason(threadId).then((result) => {
      if (live) setVerdict(result)
    })
    return () => {
      live = false
    }
  }, [threadId])

  if (!verdict) return null

  const sender = verdict.sender || t('priority.reason.nothingKnown')
  const because = verdict.reasons
    .map((reason) => t(`priority.reason.${reason}`, { sender, defaultValue: reason }))
    .join(' · ')

  const choose = (priority: boolean | null) => {
    onAct()
    void setSenderPriority(accountId, verdict.sender, priority)
  }

  return (
    <>
      <div className="my-1 border-t border-border" />
      {/* The verdict and its reason, as one line of plain words. Not a
          control: it is what the two controls below are about. */}
      <div className="px-2 pb-1 pt-0.5">
        <p className="flex items-center gap-1.5 text-caption font-semibold text-primary">
          <Sparkle size={11} className={verdict.priority ? 'text-accent' : 'text-secondary'} />
          {verdict.priority ? t('priority.isPriority') : t('priority.notPriority')}
        </p>
        <p className="mt-0.5 text-2xs leading-snug text-secondary">{because}</p>
      </div>
      <MenuItem
        icon={<Sparkle size={13} className="text-secondary" />}
        label={verdict.override === true ? t('priority.forget') : t('priority.always')}
        onClick={() => choose(verdict.override === true ? null : true)}
      />
      <MenuItem
        icon={<Sparkle size={13} className="text-secondary" />}
        label={verdict.override === false ? t('priority.forget') : t('priority.never')}
        onClick={() => choose(verdict.override === false ? null : false)}
      />
      {/* Sweeping is about this sender too, so it belongs beside the other
          things one says about a sender. */}
      {verdict.sender && (
        <MenuItem
          icon={<Wind size={13} className="text-secondary" />}
          label={t('sweep.action')}
          onClick={() => {
            onAct()
            ui$.sweep.set({ accountId, folder: folderId, sender: verdict.sender })
          }}
        />
      )}
    </>
  )
}
