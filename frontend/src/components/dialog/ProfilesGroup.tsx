import { useEffect, useState } from 'react'
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import {
  createProfile,
  deleteProfile,
  loadProfiles,
  openProfile,
  profileName,
  profiles$,
  renameProfile,
} from '../../states/profiles'
import { confirmAction } from '../../states/ui'
import { SettingsGroup } from './AccountSettingsRows'

const action =
  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-control bg-hover hover:bg-active text-primary font-bold text-2xs cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Profiles (#99, ADR-0016): each has its own accounts, mail, contacts, notes,
 * preferences and saved passwords, and opens in its own window.
 */
export function ProfilesGroup() {
  const { t } = useTranslation()
  const items = useValue(profiles$.items)
  const [adding, setAdding] = useState<string | null>(null)

  useEffect(() => {
    void loadProfiles()
  }, [])

  const rename = (id: string, current: string) => {
    const name = window.prompt(t('profiles.renamePrompt', { defaultValue: 'Profile name' }), current)
    if (name?.trim()) void renameProfile(id, name)
  }

  const remove = async (id: string, name: string) => {
    const confirmed = await confirmAction({
      title: t('profiles.deleteTitle', { defaultValue: 'Delete profile?' }),
      message: t('profiles.deleteText', { name, defaultValue: '{name} has never been opened and holds nothing.' }),
      confirmLabel: t('buttons.delete'),
      tone: 'danger',
    })
    if (confirmed) await deleteProfile(id)
  }

  return (
    <SettingsGroup title={t('profiles.title', { defaultValue: 'Profiles' })}>
      <p className="px-3.5 py-2 text-caption text-secondary">
        {t('profiles.hint', {
          defaultValue:
            'Each profile keeps its own accounts, mail, contacts, notes and saved passwords, and opens in its own window.',
        })}
      </p>
      <ul aria-label={t('profiles.title', { defaultValue: 'Profiles' })}>
        {items.map((profile) => {
          const name = profileName(profile)
          return (
            <li key={profile.id} className="flex min-h-11 items-center justify-between gap-3 px-3.5 py-2">
              <span className="min-w-0 truncate text-xs text-primary">
                {name}
                {profile.active && (
                  <span className="ml-2 text-2xs font-semibold text-secondary">
                    {t('profiles.thisWindow', { defaultValue: 'This window' })}
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {!profile.active && (
                  <button type="button" className={action} onClick={() => void openProfile(profile.id)}>
                    <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
                    {t('profiles.open', { defaultValue: 'Open' })}
                  </button>
                )}
                {profile.id !== 'default' && (
                  <button
                    type="button"
                    className={action}
                    aria-label={t('profiles.renameNamed', { name, defaultValue: 'Rename {name}' })}
                    title={t('profiles.rename', { defaultValue: 'Rename' })}
                    onClick={() => rename(profile.id, profile.name)}
                  >
                    <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
                {profile.id !== 'default' && !profile.active && !profile.has_data && (
                  <button
                    type="button"
                    className={action}
                    aria-label={t('profiles.deleteNamed', { name, defaultValue: 'Delete {name}' })}
                    title={t('buttons.delete')}
                    onClick={() => void remove(profile.id, name)}
                  >
                    <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {adding === null ? (
        <div className="px-3.5 py-2">
          <button type="button" className={action} onClick={() => setAdding('')}>
            <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
            {t('profiles.new', { defaultValue: 'New profile' })}
          </button>
        </div>
      ) : (
        <form
          className="flex items-center gap-2 px-3.5 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!adding.trim()) return
            void createProfile(adding).then((created) => created && setAdding(null))
          }}
        >
          <input
            autoFocus
            value={adding}
            maxLength={60}
            aria-label={t('profiles.newName', { defaultValue: 'New profile name' })}
            onChange={(event) => setAdding(event.target.value)}
            className="min-w-0 flex-1 rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary outline-none focus:border-accent"
          />
          <button type="submit" className={action}>
            {t('profiles.create', { defaultValue: 'Create' })}
          </button>
          <button type="button" className={action} onClick={() => setAdding(null)}>
            {t('buttons.cancel')}
          </button>
        </form>
      )}
    </SettingsGroup>
  )
}
