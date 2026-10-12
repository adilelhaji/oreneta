// Importing .eml and .mbox files into the local archive (ADR-0014): a preview
// first, then the import. Nothing is stored until the reader confirms.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { boot } from '../boot'
import { showToast } from './ui'

export const ARCHIVE_ACCOUNT = 'local-archive'

export type ImportSummary = { imported: number; duplicates: number; skipped: number }

export type PendingMailImport = { paths: string[]; folder: string; summary: ImportSummary }

export const archive$ = observable({ pending: null as PendingMailImport | null })

type Answer = { cancelled?: boolean; paths?: string[]; folder?: string; summary?: ImportSummary; created?: boolean }

/** Picks files and shows what importing them would do. */
export async function startMailImport() {
  try {
    const res = await invoke<Answer>('archive.import', {})
    if (!res || res.cancelled || !res.paths?.length || !res.summary) return
    archive$.pending.set({ paths: res.paths, folder: res.folder ?? 'INBOX', summary: res.summary })
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : t('archive.readFailed', { defaultValue: 'Could not read the files.' }),
      'error',
    )
  }
}

/** The preview again, for another target folder. */
export async function previewMailImport(pending: PendingMailImport, folder: string) {
  try {
    const res = await invoke<Answer>('archive.import', { paths: pending.paths, folder })
    if (res?.summary) archive$.pending.set({ ...pending, folder, summary: res.summary })
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : t('archive.readFailed', { defaultValue: 'Could not read the files.' }),
      'error',
    )
  }
}

export async function confirmMailImport(pending: PendingMailImport) {
  try {
    const res = await invoke<Answer>('archive.import', { paths: pending.paths, folder: pending.folder, confirm: true })
    archive$.pending.set(null)
    // The archive appears among the accounts the first time.
    if (res?.created) await boot()
    const summary = res?.summary
    showToast(
      t('archive.imported', {
        imported: summary?.imported ?? 0,
        duplicates: summary?.duplicates ?? 0,
        defaultValue:
          '{imported, plural, one {# message imported} other {# messages imported}} into the local archive{duplicates, plural, =0 {} other {; # already there}}.',
      }),
    )
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : t('archive.importFailed', { defaultValue: 'Could not import.' }),
      'error',
    )
  }
}
