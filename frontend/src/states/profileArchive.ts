// The full-profile archive (#171, ADR-0017): one encrypted file with the whole
// profile. Checking an archive opens it in a private folder; nothing in use
// is touched.
import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { showToast } from './ui'

export type ArchiveSummary = {
  created_at: number
  app_version: string
  schema_version: number
  entries: number
  bytes: number
  accounts: number
  messages: number
  excluded: { what: string; why: string }[]
}

export type ArchiveStep =
  | { kind: 'export' }
  | { kind: 'check'; path: string }
  | { kind: 'checked'; path: string; summary: ArchiveSummary }
  | { kind: 'restore'; path: string }
  | { kind: 'ready'; path: string; summary: ArchiveSummary }

export const profileArchive$ = observable({
  step: null as ArchiveStep | null,
  busy: false,
  error: '',
  /** 'activated' while a restored profile is in use and the previous one is kept aside. */
  restoreState: 'none' as 'none' | 'activated',
})

function reason(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function startProfileExport() {
  profileArchive$.assign({ step: { kind: 'export' }, error: '', busy: false })
}

export async function exportProfile(passphrase: string) {
  profileArchive$.assign({ busy: true, error: '' })
  try {
    const res = await invoke<{ saved: boolean; summary?: ArchiveSummary }>('backup.profileExport', { passphrase })
    profileArchive$.step.set(null)
    if (res?.saved && res.summary) {
      showToast(
        t('profileArchive.saved', {
          size: formatBytes(res.summary.bytes),
          defaultValue: 'Profile backed up ({size})',
        }),
      )
    }
  } catch (error) {
    profileArchive$.error.set(reason(error, t('profileArchive.failed', { defaultValue: 'The backup was not written' })))
  } finally {
    profileArchive$.busy.set(false)
  }
}

export async function startProfileCheck() {
  try {
    const res = await invoke<{ cancelled?: boolean; needsPassphrase?: boolean; path?: string }>(
      'backup.profileInspect',
      {},
    )
    if (res?.needsPassphrase && res.path)
      profileArchive$.assign({ step: { kind: 'check', path: res.path }, error: '', busy: false })
  } catch (error) {
    showToast(reason(error, t('profileArchive.couldNotOpen', { defaultValue: 'Could not open the archive' })), 'error')
  }
}

export async function checkProfile(passphrase: string) {
  const step = profileArchive$.step.peek()
  if (step?.kind !== 'check') return
  profileArchive$.assign({ busy: true, error: '' })
  try {
    const res = await invoke<{ summary: ArchiveSummary }>('backup.profileInspect', { path: step.path, passphrase })
    profileArchive$.step.set({ kind: 'checked', path: step.path, summary: res.summary })
  } catch (error) {
    profileArchive$.error.set(
      reason(error, t('profileArchive.unreadable', { defaultValue: 'The archive could not be read' })),
    )
  } finally {
    profileArchive$.busy.set(false)
  }
}

export function closeProfileArchive() {
  if (!profileArchive$.busy.peek()) profileArchive$.assign({ step: null, error: '' })
}

// ---- Restoring (#172) ---------------------------------------------------------

export async function startProfileRestore() {
  try {
    const res = await invoke<{ needsPassphrase?: boolean; path?: string }>('backup.profileRestorePrepare', {})
    if (res?.needsPassphrase && res.path)
      profileArchive$.assign({ step: { kind: 'restore', path: res.path }, error: '', busy: false })
  } catch (error) {
    showToast(reason(error, t('profileArchive.couldNotOpen', { defaultValue: 'Could not open the archive' })), 'error')
  }
}

/** Unpacks and checks the archive aside; the profile in use is not touched yet. */
export async function prepareRestore(passphrase: string) {
  const step = profileArchive$.step.peek()
  if (step?.kind !== 'restore') return
  profileArchive$.assign({ busy: true, error: '' })
  try {
    const res = await invoke<{ summary: ArchiveSummary }>('backup.profileRestorePrepare', {
      path: step.path,
      passphrase,
    })
    profileArchive$.step.set({ kind: 'ready', path: step.path, summary: res.summary })
  } catch (error) {
    profileArchive$.error.set(
      reason(error, t('profileArchive.unreadable', { defaultValue: 'The archive could not be read' })),
    )
  } finally {
    profileArchive$.busy.set(false)
  }
}

/** Reloads the window on success: everything shown came from the old profile. */
export async function activateRestore(reload: () => void = () => window.location.reload()) {
  profileArchive$.assign({ busy: true, error: '' })
  try {
    await invoke('backup.profileRestoreActivate', {})
    profileArchive$.assign({ step: null, restoreState: 'activated' })
    reload()
  } catch (error) {
    profileArchive$.error.set(
      reason(error, t('profileArchive.restoreFailed', { defaultValue: 'The profile was not restored' })),
    )
  } finally {
    profileArchive$.busy.set(false)
  }
}

export async function loadRestoreState() {
  try {
    const res = await invoke<{ state: 'none' | 'activated' | 'swapping' }>('backup.profileRestoreStatus', {})
    profileArchive$.restoreState.set(res?.state === 'activated' ? 'activated' : 'none')
  } catch {
    profileArchive$.restoreState.set('none')
  }
}

export async function keepRestoredProfile() {
  try {
    await invoke('backup.profileRestoreKeep', {})
    profileArchive$.restoreState.set('none')
    showToast(t('profileArchive.kept', { defaultValue: 'The previous profile was deleted' }))
  } catch (error) {
    showToast(
      reason(error, t('profileArchive.couldNotKeep', { defaultValue: 'Could not finish the restore' })),
      'error',
    )
  }
}

export async function undoRestore(reload: () => void = () => window.location.reload()) {
  try {
    await invoke('backup.profileRestoreUndo', {})
    profileArchive$.restoreState.set('none')
    reload()
  } catch (error) {
    showToast(reason(error, t('profileArchive.couldNotUndo', { defaultValue: 'Could not go back' })), 'error')
  }
}
