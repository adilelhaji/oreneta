import { useEffect, useState } from 'react'
import { Inbox } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { invoke } from '../../lib/bridge'
import { showToast } from '../../states/ui'
import { formatFileSize } from '../chat/messageHelpers'
import { Dialog } from './Dialog'
import { Button } from '../button/Button'

type Profile = { name: string; path: string }
type TbFolder = { id: string; account: string; path: string[]; bytes: number; imap_copy: boolean }
type Summary = { imported: number; duplicates: number; skipped: number }
type FolderResult = { id: string; target: string; summary: Summary; deleted: number }

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Importing from Thunderbird into the local archive (ADR-0041): a profile is
 * found or chosen, its folders are listed, and what importing the chosen ones
 * would do is shown before anything is stored. Thunderbird's files are only
 * read.
 */
export function ThunderbirdImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [path, setPath] = useState('')
  const [folders, setFolders] = useState<TbFolder[] | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [preview, setPreview] = useState<FolderResult[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void invoke<{ profiles: Profile[] }>('thunderbird.profiles', {}).then(
      (res) => setProfiles(res?.profiles ?? []),
      () => setProfiles([]),
    )
  }, [])

  const open = async (dir: string) => {
    setPath(dir)
    setFolders(null)
    setPreview(null)
    setBusy(true)
    try {
      const res = await invoke<{ folders: TbFolder[] }>('thunderbird.scan', { path: dir })
      const found = res?.folders ?? []
      setFolders(found)
      // The mail of an IMAP account is still on its server; its copy here may be partial.
      setChosen(found.filter((f) => !f.imap_copy).map((f) => f.id))
    } catch (error) {
      showToast(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const pick = async () => {
    try {
      const res = await invoke<{ path?: string }>('thunderbird.pickFolder', {})
      if (res?.path) await open(res.path)
    } catch (error) {
      showToast(errorText(error), 'error')
    }
  }

  const check = async () => {
    setBusy(true)
    try {
      const res = await invoke<{ folders: FolderResult[] }>('thunderbird.preview', { path, folders: chosen })
      setPreview(res?.folders ?? [])
    } catch (error) {
      showToast(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    setBusy(true)
    try {
      const res = await invoke<{ folders: FolderResult[] }>('thunderbird.import', { path, folders: chosen })
      const imported = (res?.folders ?? []).reduce((sum, f) => sum + f.summary.imported, 0)
      showToast(
        t('thunderbird.done', {
          count: imported,
          defaultValue:
            '{count, plural, one {# message imported} other {# messages imported}} into the local archive, under Thunderbird.',
        }),
        'success',
      )
      onClose()
    } catch (error) {
      showToast(errorText(error), 'error')
      setBusy(false)
    }
  }

  const toggle = (id: string) => {
    setPreview(null)
    setChosen((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]))
  }
  const total = preview?.reduce((sum, f) => sum + f.summary.imported, 0) ?? 0
  const left = preview?.reduce((sum, f) => sum + f.summary.duplicates, 0) ?? 0
  const deleted = preview?.reduce((sum, f) => sum + f.deleted, 0) ?? 0

  return (
    <Dialog
      title={t('thunderbird.title', { defaultValue: 'Import from Thunderbird' })}
      subtitle={t('thunderbird.subtitle', {
        defaultValue: 'Into the local archive on this computer. Thunderbird’s files are only read, never changed.',
      })}
      icon={Inbox}
      width="md"
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('buttons.cancel')}
          </Button>
          {preview ? (
            <Button variant="primary" size="sm" disabled={busy || total === 0} onClick={() => void run()}>
              {t('archive.importCount', {
                count: total,
                defaultValue: '{count, plural, one {Import # message} other {Import # messages}}',
              })}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !folders || chosen.length === 0}
              onClick={() => void check()}
            >
              {t('thunderbird.check', { defaultValue: 'Check what would be imported' })}
            </Button>
          )}
        </>
      }
    >
      {!folders ? (
        <div className="flex flex-col gap-2 text-ui">
          {profiles === null ? (
            <p className="text-secondary">{t('common.loading')}</p>
          ) : profiles.length === 0 ? (
            <p className="text-secondary">
              {t('thunderbird.noProfile', { defaultValue: 'No Thunderbird profile was found on this computer.' })}
            </p>
          ) : (
            <ul
              className="flex flex-col gap-1"
              aria-label={t('thunderbird.profiles', { defaultValue: 'Thunderbird profiles' })}
            >
              {profiles.map((profile) => (
                <li key={profile.path}>
                  <button
                    type="button"
                    className="w-full rounded-control px-2 py-1.5 text-left hover:bg-hover"
                    disabled={busy}
                    onClick={() => void open(profile.path)}
                    title={profile.path}
                  >
                    <span className="text-primary">{profile.name}</span>
                    <span className="ml-2 text-2xs text-secondary">{profile.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void pick()}>
              {t('thunderbird.chooseFolder', { defaultValue: 'Choose a profile or mail folder…' })}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-ui">
          {folders.length === 0 ? (
            <p className="text-secondary">
              {t('thunderbird.empty', { defaultValue: 'No mail folders were found there.' })}
            </p>
          ) : (
            <fieldset className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              <legend className="mb-1 text-secondary">
                {t('thunderbird.folders', { defaultValue: 'Folders to import' })}
              </legend>
              {folders.map((folder) => {
                const result = preview?.find((p) => p.id === folder.id)
                return (
                  <label key={folder.id} className="flex items-center gap-2">
                    <input type="checkbox" checked={chosen.includes(folder.id)} onChange={() => toggle(folder.id)} />
                    <span className="min-w-0 flex-1 truncate text-primary" title={folder.id}>
                      {folder.account} / {folder.path.join(' / ')}
                    </span>
                    <span className="shrink-0 text-2xs text-secondary">
                      {result
                        ? t('thunderbird.folderCount', {
                            count: result.summary.imported,
                            defaultValue: '{count, plural, one {# new} other {# new}}',
                          })
                        : formatFileSize(folder.bytes)}
                    </span>
                  </label>
                )
              })}
            </fieldset>
          )}
          {folders.some((f) => f.imap_copy) && (
            <p className="text-2xs text-secondary">
              {t('thunderbird.imapNote', {
                defaultValue:
                  'Folders of IMAP accounts are copies Thunderbird keeps; that mail is also on its server and the copy may be incomplete, so they are not chosen at first.',
              })}
            </p>
          )}
          {preview && (
            <p role="status" className="text-primary">
              {t('thunderbird.summary', {
                count: total,
                left,
                deleted,
                defaultValue:
                  '{count, plural, one {# message} other {# messages}} to import. {left} already in the archive and {deleted} deleted in Thunderbird are left out.',
              })}
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}
