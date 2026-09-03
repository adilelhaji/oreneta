import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { previewKind, TEXT_PREVIEW_MAX_BYTES } from '../../lib/attachmentPreview'
import { downloadAttachment } from '../../states/mail'
import { formatFileSize } from './messageHelpers'
import { Button } from '../button/Button'
import { Dialog } from '../dialog/Dialog'
import { PdfPreview } from './PdfPreview'
import type { Attachment } from '../../types'

/**
 * An attachment, shown without leaving the app.
 *
 * Saving stays one click away and is never taken off the table: a preview is
 * for deciding whether to keep the file, not a replacement for keeping it.
 */
export function AttachmentPreviewDialog({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const { t } = useTranslation()
  const kind = previewKind(attachment)
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

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
    <Dialog
      title={attachment.filename}
      subtitle={formatFileSize(attachment.size)}
      width="xl"
      onClose={onClose}
      className="select-auto"
      footer={
        <Button size="sm" leftIcon={Download} onClick={() => void downloadAttachment(attachment)}>
          {t('chat.saveFile', { filename: attachment.filename })}
        </Button>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto rounded-panel border border-border bg-raised">
        {failed ? (
          <p className="p-6 text-center text-ui text-secondary">{t('attachments.previewFailed')}</p>
        ) : kind === 'image' ? (
          <img
            src={`/media/${attachment.key}`}
            alt={attachment.filename}
            className="mx-auto max-h-[70vh] w-auto max-w-full object-contain"
            onError={() => setFailed(true)}
          />
        ) : kind === 'pdf' ? (
          <PdfPreview src={`/media/${attachment.key}`} onFailed={() => setFailed(true)} />
        ) : kind === 'text' ? (
          text === null ? (
            <p className="p-6 text-center text-ui text-secondary">{t('attachments.previewLoading')}</p>
          ) : (
            <pre className="max-h-[70vh] overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words select-text">
              {text}
            </pre>
          )
        ) : (
          <p className="p-6 text-center text-ui text-secondary">{t('attachments.noPreview')}</p>
        )}
      </div>
    </Dialog>
  )
}
