import { useEffect, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import {
  checkCloud,
  cloudAccounts$,
  cloudErrorText,
  cloudProviders$,
  refreshCloud,
  removeCloudAccount,
  saveCloudAccount,
} from '../../states/cloud'
import { showToast } from '../../states/ui'
import { Button } from '../button/Button'
import { SettingsGroup } from './AccountSettingsRows'

const input = 'rounded-control-sm border border-border bg-app px-2 py-1 text-caption text-primary'

/**
 * Cloud storage for sharing files by link (#108, ADR-0033). Nextcloud and
 * ownCloud with an app password, kept in the system keychain; the providers
 * that need an Oreneta registration are listed as not available yet.
 */
export function CloudStorageGroup() {
  const { t } = useTranslation()
  const accounts = useValue(cloudAccounts$)
  const providers = useValue(cloudProviders$)
  const [form, setForm] = useState({ provider: 'nextcloud', server: '', username: '', password: '', folder: 'Oreneta' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refreshCloud().catch(() => {})
  }, [])

  const add = async () => {
    setBusy(true)
    const id = `cloud-${Date.now().toString(36)}`
    try {
      const host = (() => {
        try {
          return new URL(form.server).host
        } catch {
          return form.server
        }
      })()
      await saveCloudAccount(
        {
          id,
          provider: form.provider,
          name: `${providers.find((p) => p.id === form.provider)?.name ?? form.provider} · ${host}`,
          server: form.server,
          username: form.username,
          folder: form.folder,
        },
        form.password,
      )
      const checked = await checkCloud(id)
      if (checked.error) {
        await removeCloudAccount(id)
        showToast(cloudErrorText(checked.error, t), 'error')
        return
      }
      setForm((f) => ({ ...f, server: '', username: '', password: '' }))
      showToast(
        checked.capabilities?.links
          ? t('cloud.added', { defaultValue: 'Connected. Links can be made from the composer.' })
          : t('cloud.addedNoLinks', { defaultValue: 'Connected, but this server does not allow links.' }),
      )
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsGroup title={t('cloud.settingsTitle', { defaultValue: 'Cloud storage' })}>
      <div className="flex flex-col gap-2 px-3.5 py-3 text-caption">
        <p className="text-secondary">
          {t('cloud.settingsHint', {
            defaultValue:
              'Share a large file as a link instead of attaching it. Use an app password from your server’s security settings; it is kept in the system keychain.',
          })}
        </p>
        <ul className="flex flex-col divide-y divide-border/40">
          {accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="text-primary">{a.name}</span>
              <span className="text-secondary">
                {a.username} · {a.folder}
              </span>
              <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void removeCloudAccount(a.id)}>
                {t('cloud.remove', { defaultValue: 'Remove' })}
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-secondary">
            {t('cloud.provider', { defaultValue: 'Provider' })}
            <select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
              className={input}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.usable}>
                  {p.usable ? p.name : t('cloud.notYet', { name: p.name, defaultValue: '{name} (not available yet)' })}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-secondary">
            {t('cloud.server', { defaultValue: 'Server (https://…)' })}
            <input
              value={form.server}
              onChange={(e) => setForm({ ...form, server: e.target.value })}
              className={input}
            />
          </label>
          <label className="flex flex-col gap-1 text-secondary">
            {t('cloud.user', { defaultValue: 'User name' })}
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className={input}
            />
          </label>
          <label className="flex flex-col gap-1 text-secondary">
            {t('cloud.appPassword', { defaultValue: 'App password' })}
            <input
              type="password"
              autoComplete="off"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className={input}
            />
          </label>
          <label className="flex flex-col gap-1 text-secondary">
            {t('cloud.folder', { defaultValue: 'Folder' })}
            <input
              value={form.folder}
              onChange={(e) => setForm({ ...form, folder: e.target.value })}
              className={input}
            />
          </label>
          <Button
            size="sm"
            disabled={busy || !form.server || !form.username || !form.password}
            onClick={() => void add()}
          >
            {t('cloud.add', { defaultValue: 'Add' })}
          </Button>
        </div>
        <p className="text-secondary">
          {t('cloud.unavailableHint', {
            defaultValue:
              'Dropbox, OneDrive and Google Drive need Oreneta to be registered with each provider, which has not been done yet.',
          })}
        </p>
      </div>
    </SettingsGroup>
  )
}
