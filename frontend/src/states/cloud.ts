// Sharing files by link from cloud storage (#108, ADR-0033).
//
// The core uploads and creates the link; this keeps the person's accounts,
// follows an upload's progress, and says what went wrong in their terms.

import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'

export type CloudProvider = { id: string; name: string; usable: boolean }
export type CloudAccount = {
  id: string
  provider: string
  name: string
  server: string
  username: string
  folder: string
}
export type CloudCapabilities = {
  links: boolean
  password_enforced: boolean
  expiry_enforced: boolean
  expiry_max_days: number | null
}
export type CloudLink = {
  id: string
  url: string
  path: string
  view_only: boolean
  expires: string | null
  password_protected: boolean
}
export type CloudError = { message: string; detail?: { code: string; detail?: string; status?: number } }
export type PickedFile = { path: string; name: string; size: number }

export const cloudAccounts$ = observable<CloudAccount[]>([])
export const cloudProviders$ = observable<CloudProvider[]>([])

export async function refreshCloud() {
  const [accounts, providers] = await Promise.all([
    invoke<CloudAccount[]>('cloud.list', {}),
    invoke<CloudProvider[]>('cloud.providers', {}),
  ])
  cloudAccounts$.set(accounts ?? [])
  cloudProviders$.set(providers ?? [])
}

export async function saveCloudAccount(account: CloudAccount, password: string) {
  await invoke('cloud.save', { account, password })
  await refreshCloud()
}

export async function removeCloudAccount(id: string) {
  await invoke('cloud.remove', { id })
  await refreshCloud()
}

export async function checkCloud(id: string): Promise<{ capabilities?: CloudCapabilities; error?: CloudError }> {
  return invoke('cloud.check', { id })
}

export async function pickCloudFile(): Promise<PickedFile | null> {
  const picked = await invoke<PickedFile | { cancelled: true }>('cloud.pickFile', {})
  return 'path' in picked ? picked : null
}

// ---- Uploads -------------------------------------------------------------------------

export const cloudUploads$ = observable<Record<string, { done: number; total: number }>>({})
const finished = new Map<string, (result: { path?: string; error?: CloudError }) => void>()

/** Called for the core's `cloud.progress` and `cloud.uploaded`. */
export function onCloudEvent(
  name: string,
  detail: { upload_id: string; done?: number; total?: number; path?: string; error?: CloudError },
) {
  if (name === 'cloud.progress') {
    cloudUploads$[detail.upload_id].set({ done: detail.done ?? 0, total: detail.total ?? 0 })
  }
  if (name === 'cloud.uploaded') {
    cloudUploads$[detail.upload_id].delete()
    finished.get(detail.upload_id)?.({ path: detail.path, error: detail.error })
    finished.delete(detail.upload_id)
  }
}

/** Uploads a file and resolves with where it went, or why not. */
export async function uploadToCloud(
  accountId: string,
  file: PickedFile,
  uploadId: string,
): Promise<{ path?: string; error?: CloudError }> {
  const done = new Promise<{ path?: string; error?: CloudError }>((resolve) => finished.set(uploadId, resolve))
  cloudUploads$[uploadId].set({ done: 0, total: file.size })
  try {
    await invoke('cloud.upload', { id: accountId, path: file.path, upload_id: uploadId })
  } catch (error) {
    finished.delete(uploadId)
    cloudUploads$[uploadId].delete()
    return { error: { message: error instanceof Error ? error.message : String(error) } }
  }
  return done
}

export async function cancelCloudUpload(uploadId: string) {
  await invoke('cloud.cancel', { upload_id: uploadId })
}

export async function createCloudLink(
  accountId: string,
  path: string,
  link: { password?: string; expires?: string },
): Promise<{ link?: CloudLink; error?: CloudError }> {
  return invoke('cloud.share', { id: accountId, path, link })
}

export async function revokeCloudLink(accountId: string, shareId: string) {
  await invoke('cloud.revoke', { id: accountId, share_id: shareId })
}

/** What went wrong, said for a person. */
export function cloudErrorText(
  error: CloudError | undefined,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  switch (error?.detail?.code) {
    case 'revoked':
      return t('cloud.error.revoked', {
        defaultValue: 'The server no longer accepts the app password. Create a new one and save it in Settings.',
      })
    case 'quota':
      return t('cloud.error.quota', { defaultValue: 'The cloud storage is full. Nothing was left there.' })
    case 'cancelled':
      return t('cloud.error.cancelled', { defaultValue: 'Cancelled. Nothing was left there.' })
    case 'permissionMismatch':
      return t('cloud.error.mismatch', {
        detail: error.detail.detail ?? '',
        defaultValue: 'The server made a different link than asked ({detail}), so it was withdrawn.',
      })
    default:
      return error?.message ?? ''
  }
}

/** A password for a link: random, readable, never stored by the app. */
export function linkPassword(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(random(16), (b) => alphabet[b % alphabet.length]).join('')
}

/** The day a link stops working, `days` from `now`, as the server wants it. */
export function expiryDate(days: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
