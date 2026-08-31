import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { previewKind, TEXT_PREVIEW_MAX_BYTES } from '../../lib/attachmentPreview'
import { downloadAttachment } from '../../states/mail'
import { formatFileSize } from './messageHelpers'
import { IconButton } from '../button/IconButton'
import type { Attachment } from '../../types'

/**
 * An attachment, shown without leaving the app.
 *
 * Saving stays one click away and is never taken off the table: a preview is
 * for deciding whether to keep the file, not a replacement for keeping it.
 */
export function AttachmentPreviewDialog({
  attachment,
  onClose,
}: {
  attachment: Attachment
  onClose: () => void
}) {
  const { t } = useTranslation()
  const kind = previewKind(attachment)
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEscapeKey(onClose, true)

  useEffect(() => {
    if (kind !== 'text' || !attachment.key) return
    let live = true
    void fetch(`/media/${attachment.key}`)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error('unreadable'))))
      .then((body) => {
        if (live) setText(body.slice(0, TEXT_PREVIEW_MAX_BYTES))
      })
      .catch(() => {
        // Said plainly rather than left as an empty box: an empty preview
        // reads as an empty file.
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [kind, attachment.key])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[3px] animate-fade-in dark:bg-black/70"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col gap-3 rounded-3xl border border-border bg-chats p-5 text-primary shadow-2xl animate-slide-up"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[0.875rem] font-bold">{attachment.filename}</p>
            <p className="text-[0.65625rem] text-secondary">{formatFileSize(attachment.size)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              icon={Download}
              iconSize={16}
              label={t('chat.saveFile', { filename: attachment.filename })}
              radius="xl"
              onClick={() => void downloadAttachment(attachment)}
            />
            <IconButton icon={X} iconSize={16} label={t('buttons.close')} radius="xl" onClick={onClose} />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-panel">
          {failed ? (
            <p className="p-6 text-center text-[0.8125rem] text-secondary">{t('attachments.previewFailed')}</p>
          ) : kind === 'image' ? (
            <img
              src={`/media/${attachment.key}`}
              alt={attachment.filename}
              className="mx-auto max-h-[70vh] w-auto max-w-full object-contain"
              onError={() => setFailed(true)}
            />
          ) : kind === 'text' ? (
            text === null ? (
              <p className="p-6 text-center text-[0.8125rem] text-secondary">{t('attachments.previewLoading')}</p>
            ) : (
              <pre className="max-h-[70vh] overflow-auto p-4 font-mono text-[0.75rem] leading-relaxed whitespace-pre-wrap break-words select-text">
                {text}
              </pre>
            )
          ) : (
            <p className="p-6 text-center text-[0.8125rem] text-secondary">{t('attachments.noPreview')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
