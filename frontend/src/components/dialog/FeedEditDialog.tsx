import { useState } from 'react'
import { Rss, Trash2, Copy, Check } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { removeFeed } from '../../states/feeds'
import { ui$ } from '../../states/ui'
import { Button } from '../button/Button'
import { IconButton } from '../button/IconButton'
import { Dialog } from './Dialog'

export function FeedEditDialog() {
  const { t } = useTranslation()
  const feed = useValue(ui$.editFeed)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [copied, setCopied] = useState(false)

  const onClose = () => {
    if (deleting) return
    ui$.editFeed.set(null)
  }

  if (!feed) return null

  const onCopy = async () => {
    if (!feed.url) return
    await navigator.clipboard.writeText(feed.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const onDelete = async () => {
    if (deleting) return
    // Two presses, not a confirm dialog: the second press is the confirmation,
    // and the button says so between them.
    if (!confirming) {
      setConfirming(true)
      return
    }
    setDeleting(true)
    await removeFeed(feed.threadId)
    setDeleting(false)
  }

  return (
    <Dialog
      title={feed.name}
      subtitle={feed.url || t('feeds.manageSubscription')}
      icon={Rss}
      onClose={onClose}
      closeDisabled={deleting}
      footer={
        <>
          <Button variant="danger" leftIcon={Trash2} onClick={onDelete} disabled={deleting} className="mr-auto">
            {confirming ? t('feeds.actions.confirmDelete') : t('feeds.actions.deleteFeed')}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={deleting}>
            {t('buttons.close')}
          </Button>
        </>
      }
    >
      {feed.url && (
        <div className="flex flex-col gap-2">
          <span className="px-1 text-caption font-semibold text-secondary">{t('feeds.url')}</span>
          <div className="flex items-center gap-2 rounded-control bg-hover px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-caption font-medium text-primary select-text">{feed.url}</span>
            <IconButton
              icon={copied ? Check : Copy}
              iconSize={14}
              size="sm"
              radius="lg"
              label={copied ? t('common.copied') : t('feeds.copyUrl')}
              className={copied ? 'text-emerald-500' : undefined}
              onClick={() => void onCopy()}
            />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="px-1 text-caption font-semibold text-secondary">{t('feeds.actions.deleteFeed')}</span>
        <p className="px-1 text-caption font-medium leading-relaxed text-secondary">{t('feeds.deleteHint')}</p>
      </div>
    </Dialog>
  )
}
