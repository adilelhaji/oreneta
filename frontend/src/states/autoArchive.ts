// Automatic archiving by age (#112, ADR-0054). The core keeps each account's
// policy, its confirmation and the run log; this only carries them to the
// screen and back.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { boot } from '../boot'
import { t } from '../lib/i18n'
import { showToast } from './ui'

export type AgeUnit = 'days' | 'months'
export type Age = { value: number; unit: AgeUnit }
export type FolderChoice = { name: string; older_than?: Age | null }
export type Destination = 'server' | 'local'

export type AutoArchivePolicy = {
  enabled: boolean
  older_than: Age
  folders: FolderChoice[]
  destination: Destination
  keep_server_copy: boolean
  include_starred: boolean
  include_unread: boolean
}

export type ItemFailure = { folder: string; uid: number; subject: string; step: string; error: string }
export type FolderOutcome = { folder: string; selected: number; moved: number; kept: number; failed: number }

export type AutoArchiveRun = {
  id: number
  account: string
  started_at: number
  finished_at: number
  trigger: 'scheduled' | 'manual' | string
  destination: Destination | null
  target: string
  moved: number
  kept: number
  failed: number
  gone: number
  folders: FolderOutcome[]
  failures: ItemFailure[]
  error: string | null
}

export type FolderOption = { name: string; display_name: string; refused: string | null }

export type AutoArchiveStatus = {
  policy: AutoArchivePolicy
  confirmed: boolean
  last_attempt: number | null
  last_success: number | null
  last_error: string | null
  next_run: number | null
  running: boolean
  local_supported: boolean
  folders: FolderOption[]
  runs: AutoArchiveRun[]
}

export type PlannedFolder = {
  folder: string
  cutoff: number
  target: string
  count: number
  oldest: number | null
  newest: number | null
}

export type AutoArchivePlan = {
  account: string
  destination: Destination
  target: string
  folders: PlannedFolder[]
  total: number
  fingerprint: string
}

/** Bumped when a scheduled run ends, so an open Settings page reloads. */
export const autoArchiveRan$ = observable<{ account: string; at: number } | null>(null)

export const loadAutoArchive = (account: string) => invoke<AutoArchiveStatus>('autoArchive.status', { account })

export const previewAutoArchive = (account: string, policy: AutoArchivePolicy) =>
  invoke<AutoArchivePlan>('autoArchive.preview', { account, policy })

/** Saves a policy; `confirm` is the fingerprint of the preview the person accepted. */
export const saveAutoArchive = (account: string, policy: AutoArchivePolicy, confirm?: string) =>
  invoke<AutoArchiveStatus>('autoArchive.save', confirm ? { account, policy, confirm } : { account, policy })

export async function runAutoArchiveNow(account: string) {
  const answer = await invoke<{ run: AutoArchiveRun; archive_created: boolean; status: AutoArchiveStatus }>(
    'autoArchive.runNow',
    { account },
  )
  // The local archive appears among the accounts the first time.
  if (answer.archive_created) await boot()
  return answer
}

/** Called for the core's `autoArchive.ran`, after a scheduled run. */
export async function onAutoArchiveRan(detail: {
  account?: string
  run?: AutoArchiveRun | null
  archive_created?: boolean
  error?: string | null
}) {
  if (!detail?.account) return
  autoArchiveRan$.set({ account: detail.account, at: Date.now() })
  if (detail.archive_created) await boot()
  const problem = detail.error || detail.run?.error
  if (problem) {
    showToast(
      t('autoArchive.failedToast', {
        error: problem,
        defaultValue: 'Automatic archiving did not run: {error}. Nothing was moved.',
      }),
      'error',
    )
  } else if (detail.run && detail.run.failed > 0) {
    showToast(
      t('autoArchive.partialToast', {
        count: detail.run.failed,
        defaultValue:
          'Automatic archiving left {count, plural, one {# message} other {# messages}} where they were. See the run log in Settings.',
      }),
      'error',
    )
  }
}
