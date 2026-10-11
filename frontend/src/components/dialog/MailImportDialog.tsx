import { useState } from 'react'
import { Inbox } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { archive$, confirmMailImport, previewMailImport } from '../../states/archive'
import { Dialog } from './Dialog'
import { Button } from '../button/Button'
import { TextInput } from '../field/Field'

/** What importing .eml/.mbox files would do, before anything is stored (ADR-0014). */
export function MailImportDialog() {
  const { t } = useTranslation()
  const pending = useValue(archive$.pending)
  const [busy, setBusy] = useState(false)
  const [folder, setFolder] = useState('')
  if (!pending) return null
  const close = () => archive$.pending.set(null)
  const { imported, duplicates, skipped } = pending.summary
  const target = folder.trim() || pending.folder

  return (
    <Dialog
      title={t('archive.importTitle', { defaultValue: 'Import mail into the local archive' })}
      subtitle={t('archive.localOnly', {
        defaultValue: 'Kept on this computer only. The files you picked are read, never changed.',
      })}
      icon={Inbox}
      width="md"
      onClose={close}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
            {t('buttons.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || imported === 0}
            onClick={async () => {
              setBusy(true)
              if (target !== pending.folder) await previewMailImport(pending, target)
              const current = archive$.pending.get()
              if (current) await confirmMailImport(current)
              setBusy(false)
            }}
          >
            {busy
              ? t('common.loading')
              : t('archive.importCount', {
                  count: imported,
                  defaultValue: '{count, plural, one {Import # message} other {Import # messages}}',
                })}
          </Button>
        </>
      }
    >
      <p className="text-ui text-primary">
        {t('archive.summary', {
          files: pending.paths.length,
          imported,
          defaultValue:
            '{files, plural, one {# file} other {# files}}: {imported, plural, one {# message} other {# messages}} to import.',
        })}
      </p>
      {(duplicates > 0 || skipped > 0) && (
        <p className="mt-1 text-caption text-secondary">
          {t('archive.leftOut', {
            duplicates,
            skipped,
            defaultValue:
              '{duplicates, plural, =0 {} one {# already in that folder} other {# already in that folder}}{duplicates, plural, =0 {} other {{skipped, plural, =0 {} other {; }}}}{skipped, plural, =0 {} one {# is not a message or is too large} other {# are not messages or are too large}}. They are left out.',
          })}
        </p>
      )}
      <label className="mt-4 flex flex-col gap-1.5">
        <span className="text-caption font-bold uppercase tracking-wide text-secondary">
          {t('archive.folder', { defaultValue: 'Folder in the archive' })}
        </span>
        <TextInput
          value={folder}
          placeholder={pending.folder}
          onChange={(e) => setFolder(e.target.value)}
          fieldSize="md"
          surface="app"
        />
      </label>
    </Dialog>
  )
}
