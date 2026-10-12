import { useEffect, useState } from 'react'
import { Download, Paperclip, X } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { confirmAction, showToast } from '../../states/ui'
import { formatFileSize } from '../chat/messageHelpers'

type Attachment = { id: string; note_id: string; filename: string; size: number; created_at: number }

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Files attached to a note (ADR-0042): kept in the profile with the note, so
 * a full backup carries them. Read-only while the note is in the trash.
 */
export function NoteAttachments({ noteId, readOnly }: { noteId: string; readOnly: boolean }) {
  const { t } = useTranslation()
  const [files, setFiles] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)

  const load = () =>
    invoke<{ attachments: Attachment[] }>('notes.attachments', { note_id: noteId }).then(
      (res) => setFiles(res?.attachments ?? []),
      () => setFiles([]),
    )
  useEffect(() => {
    let current = true
    void invoke<{ attachments: Attachment[] }>('notes.attachments', { note_id: noteId }).then(
      (res) => current && setFiles(res?.attachments ?? []),
      () => current && setFiles([]),
    )
    return () => {
      current = false
    }
  }, [noteId])

  const attach = async () => {
    try {
      const picked = await invoke<{ path?: string }>('notes.pickAttachment', {})
      if (!picked?.path) return
      setBusy(true)
      await invoke('notes.attach', { note_id: noteId, path: picked.path })
      await load()
    } catch (error) {
      showToast(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const save = async (file: Attachment) => {
    try {
      const res = await invoke<{ saved?: boolean }>('notes.saveAttachmentAs', { id: file.id, filename: file.filename })
      if (res?.saved) showToast(t('notes.fileSaved', { name: file.filename, defaultValue: '{name} saved.' }), 'success')
    } catch (error) {
      showToast(errorText(error), 'error')
    }
  }

  const remove = async (file: Attachment) => {
    const confirmed = await confirmAction({
      title: t('notes.removeFileTitle', { defaultValue: 'Remove the file?' }),
      message: t('notes.removeFileText', {
        name: file.filename,
        defaultValue: '{name} is removed from this note. The copy you attached it from is not touched.',
      }),
      confirmLabel: t('notes.removeFile', { defaultValue: 'Remove' }),
      tone: 'danger',
    })
    if (!confirmed) return
    try {
      await invoke('notes.removeAttachment', { id: file.id })
      await load()
    } catch (error) {
      showToast(errorText(error), 'error')
    }
  }

  if (readOnly && files.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
      <ul
        className="flex min-w-0 flex-1 flex-wrap gap-2"
        aria-label={t('notes.files', { defaultValue: 'Attached files' })}
      >
        {files.map((file) => (
          <li
            key={file.id}
            className="flex items-center gap-1 rounded-control-sm border border-border bg-app px-2 py-1 text-caption"
          >
            <Paperclip size={12} strokeWidth={1.75} className="text-secondary" aria-hidden="true" />
            <span className="max-w-48 truncate text-primary" title={file.filename}>
              {file.filename}
            </span>
            <span className="text-2xs text-secondary">{formatFileSize(file.size)}</span>
            <button
              type="button"
              className="rounded p-0.5 text-secondary hover:bg-hover hover:text-primary cursor-pointer"
              aria-label={t('notes.saveFile', { name: file.filename, defaultValue: 'Save {name}' })}
              onClick={() => void save(file)}
            >
              <Download size={12} strokeWidth={1.75} />
            </button>
            {!readOnly && (
              <button
                type="button"
                className="rounded p-0.5 text-secondary hover:bg-danger-soft hover:text-danger cursor-pointer"
                aria-label={t('notes.removeNamed', { name: file.filename, defaultValue: 'Remove {name}' })}
                onClick={() => void remove(file)}
              >
                <X size={12} strokeWidth={1.75} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void attach()}
          className="flex items-center gap-1 rounded-control-sm px-2 py-1 text-caption text-secondary hover:bg-hover hover:text-primary cursor-pointer disabled:opacity-50"
        >
          <Paperclip size={14} strokeWidth={1.75} aria-hidden="true" />
          {busy ? t('common.loading') : t('notes.attachFile', { defaultValue: 'Attach a file…' })}
        </button>
      )}
    </div>
  )
}
