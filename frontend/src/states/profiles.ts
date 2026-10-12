// Profiles (#99, ADR-0016): separate sets of accounts and data on one
// computer. Each opens in its own window; nothing is switched in place.
import { observable } from '@legendapp/state'
import { invoke } from '../lib/bridge'
import { t } from '../lib/i18n'
import { showToast } from './ui'

export type Profile = { id: string; name: string; created_at: number; active: boolean; has_data: boolean }

export const profiles$ = observable({ items: [] as Profile[], loaded: false })

/** The default profile has no name of its own: it is the one every install has. */
export function profileName(profile: Pick<Profile, 'id' | 'name'>): string {
  return profile.name || t('profiles.default', { defaultValue: 'Main profile' })
}

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export async function loadProfiles() {
  try {
    const res = await invoke<{ profiles: Profile[] }>('profiles.list')
    profiles$.items.set(res?.profiles ?? [])
  } catch (error) {
    showToast(message(error, t('profiles.couldNotLoad', { defaultValue: 'Could not read the profiles' })), 'error')
  } finally {
    profiles$.loaded.set(true)
  }
}

export async function createProfile(name: string) {
  try {
    await invoke('profiles.create', { name })
    await loadProfiles()
    return true
  } catch (error) {
    showToast(message(error, t('profiles.couldNotCreate', { defaultValue: 'Could not create the profile' })), 'error')
    return false
  }
}

export async function renameProfile(id: string, name: string) {
  try {
    await invoke('profiles.rename', { id, name })
    await loadProfiles()
  } catch (error) {
    showToast(message(error, t('profiles.couldNotRename', { defaultValue: 'Could not rename the profile' })), 'error')
  }
}

export type ProfileDeletion = { ok: boolean; purgeFailed?: string; secretsRemoved?: boolean }

/**
 * Deletes another profile. One holding data needs its name typed; when its
 * saved passwords could not be removed, the answer says so and nothing is
 * deleted unless `force` is given (ADR-0038).
 */
export async function deleteProfile(
  id: string,
  options: { confirmName?: string; force?: boolean } = {},
): Promise<ProfileDeletion | null> {
  try {
    const result = await invoke<ProfileDeletion>('profiles.delete', { id, ...options })
    await loadProfiles()
    return result ?? { ok: true }
  } catch (error) {
    showToast(message(error, t('profiles.couldNotDelete', { defaultValue: 'Could not delete the profile' })), 'error')
    return null
  }
}

export async function openProfile(id: string) {
  try {
    await invoke('profiles.open', { id })
    showToast(t('profiles.opening', { defaultValue: 'Opening in its own window' }))
  } catch (error) {
    showToast(message(error, t('profiles.couldNotOpen', { defaultValue: 'Could not open the profile' })), 'error')
  }
}
