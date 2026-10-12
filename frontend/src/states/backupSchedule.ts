// Scheduled profile backups (#173, ADR-0037). The core keeps the schedule
// and the password (in the keychain); this keeps what is on screen.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type BackupSchedule = {
  enabled: boolean
  folder: string
  every_hours: number
  keep: number
  max_bytes: number | null
}
export type KeptBackup = { path: string; created_at: number; bytes: number; verified: boolean; present: boolean }
export type BackupScheduleStatus = {
  schedule: BackupSchedule
  last_attempt: number | null
  last_success: number | null
  last_error: string | null
  next_run: number | null
  backups: KeptBackup[]
  password_saved: boolean
  running: boolean
}

export const backupSchedule$ = observable<BackupScheduleStatus | null>(null)

export async function loadBackupSchedule() {
  backupSchedule$.set(await invoke<BackupScheduleStatus>('backupSchedule.status', {}))
}

/** Saves the schedule; a password is sent only when the person typed one. */
export async function saveBackupSchedule(schedule: BackupSchedule, password?: string) {
  backupSchedule$.set(
    await invoke<BackupScheduleStatus>('backupSchedule.save', password ? { schedule, password } : { schedule }),
  )
}

export async function runBackupNow() {
  const current = backupSchedule$.peek()
  if (current) backupSchedule$.running.set(true)
  try {
    backupSchedule$.set(await invoke<BackupScheduleStatus>('backupSchedule.runNow', {}))
  } catch (error) {
    await loadBackupSchedule().catch(() => {})
    throw error
  }
}

/** Called for the core's `backup.scheduled`. */
export function onBackupScheduled(detail: { state?: string; status?: BackupScheduleStatus | null }) {
  if (detail?.status) backupSchedule$.set(detail.status)
  else if (detail?.state === 'running' && backupSchedule$.peek()) backupSchedule$.running.set(true)
}
