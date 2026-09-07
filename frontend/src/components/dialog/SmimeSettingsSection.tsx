import { useEffect, useState } from 'react'
import { FileBadge, KeyRound, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { pickFileAsBase64 } from '../../lib/nativeFilePicker'
import { confirmAction, showToast } from '../../states/ui'
import {
  importSmimeCert,
  importSmimeIdentity,
  loadSmimeCerts,
  loadSmimeIdentities,
  removeSmimeCert,
  removeSmimeIdentity,
  smime$,
  smimeIdentities$,
} from '../../states/smime'
import { SettingsGroup } from './AccountSettingsRows'

/** Fingerprints are read four characters at a time, or not at all. */
function grouped(fingerprint: string): string {
  return (fingerprint.match(/.{1,4}/g) ?? [fingerprint]).join(' ')
}

/**
 * The S/MIME certificates used to check signatures.
 *
 * A file picker rather than pasting, unlike the OpenPGP screen right below
 * it: an S/MIME certificate is not text anyone pastes, it is a `.cer` or
 * `.p7b` a colleague sent, or one exported from another client. Verifying
 * only, and the intro says so — S/MIME decryption and signing what is sent
 * are their own, later features.
 */
export function SmimeSettingsSection() {
  const { t } = useTranslation()
  const certs = useValue(smime$.certs)
  const loaded = useValue(smime$.loaded)
  const identities = useValue(smimeIdentities$.identities)
  const identitiesLoaded = useValue(smimeIdentities$.loaded)
  const [busy, setBusy] = useState(false)
  const [identityBusy, setIdentityBusy] = useState(false)
  const [pendingIdentity, setPendingIdentity] = useState<{ name: string; base64: string } | null>(null)
  const [identityPassword, setIdentityPassword] = useState('')
  const [identityError, setIdentityError] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) void loadSmimeCerts()
  }, [loaded])

  useEffect(() => {
    if (!identitiesLoaded) void loadSmimeIdentities()
  }, [identitiesLoaded])

  const add = async () => {
    setBusy(true)
    try {
      const picked = await pickFileAsBase64(t('crypto.smime.importCert'))
      if (!picked) return
      const fingerprint = await importSmimeCert(picked.base64)
      showToast(t('crypto.imported', { fingerprint: grouped(fingerprint.slice(-16)) }))
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('crypto.importFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const pickIdentityFile = async () => {
    const picked = await pickFileAsBase64(t('crypto.smime.importIdentity'))
    if (picked) {
      setPendingIdentity(picked)
      setIdentityPassword('')
      setIdentityError(null)
    }
  }

  const unlockIdentity = async () => {
    if (!pendingIdentity) return
    setIdentityBusy(true)
    setIdentityError(null)
    try {
      const fingerprint = await importSmimeIdentity(pendingIdentity.base64, identityPassword)
      showToast(t('crypto.imported', { fingerprint: grouped(fingerprint.slice(-16)) }))
      setPendingIdentity(null)
      setIdentityPassword('')
    } catch (error) {
      setIdentityError(error instanceof Error ? error.message : t('crypto.importFailed'))
    } finally {
      setIdentityBusy(false)
    }
  }

  return (
    <SettingsGroup title={t('crypto.smime.title')}>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <p className="text-caption text-secondary">{t('crypto.smime.intro')}</p>

        <div className="flex flex-col gap-2 rounded-control border border-border bg-panel px-3 py-2.5">
          <span className="text-caption font-semibold text-primary">{t('crypto.smime.yourIdentityTitle')}</span>
          <p className="text-2xs text-secondary">{t('crypto.smime.yourIdentityIntro')}</p>

          {identities.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {identities.map((identity) => (
                <li
                  key={identity.fingerprint}
                  className="flex items-center gap-2 rounded-control-sm border border-border bg-app px-2.5 py-1.5"
                >
                  <KeyRound size={14} className="shrink-0 text-secondary" />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-semibold">
                      {identity.subject || identity.addresses[0] || t('crypto.unnamedKey')}
                    </span>
                    <span className="block truncate text-2xs text-secondary">
                      {identity.addresses.join(', ')}
                    </span>
                  </div>
                  <button
                    type="button"
                    title={t('crypto.removeKey')}
                    aria-label={t('crypto.removeKey')}
                    onClick={() => {
                      void confirmAction({
                        title: t('crypto.removeKeyTitle'),
                        message: t('crypto.removeKeyMessage', {
                          name: identity.subject || identity.fingerprint,
                        }),
                        confirmLabel: t('crypto.removeKey'),
                        cancelLabel: t('buttons.cancel'),
                        tone: 'danger',
                      }).then((yes) => {
                        if (yes) void removeSmimeIdentity(identity.fingerprint)
                      })
                    }}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-rose-500/10 hover:text-rose-500 cursor-pointer"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {pendingIdentity ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void unlockIdentity()
              }}
            >
              <span className="min-w-0 flex-1 truncate text-2xs text-secondary">{pendingIdentity.name}</span>
              <input
                type="password"
                value={identityPassword}
                autoFocus
                onChange={(event) => setIdentityPassword(event.target.value)}
                placeholder={t('crypto.passphrasePlaceholder')}
                aria-label={t('crypto.passphrasePlaceholder')}
                autoComplete="off"
                className="min-w-0 flex-1 rounded-control border border-border bg-app px-2.5 py-1 text-ui text-primary placeholder-secondary outline-none focus:border-accent/50"
              />
              <button
                type="submit"
                disabled={identityBusy || !identityPassword}
                className="shrink-0 rounded-control bg-accent px-3 py-1 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer disabled:opacity-50"
              >
                {identityBusy ? t('common.loading') : t('crypto.openIt')}
              </button>
              <button
                type="button"
                onClick={() => setPendingIdentity(null)}
                className="shrink-0 rounded-control px-2 py-1 text-caption text-secondary hover:text-primary cursor-pointer"
              >
                {t('buttons.cancel')}
              </button>
            </form>
          ) : (
            <div>
              <button
                type="button"
                onClick={() => void pickIdentityFile()}
                className="rounded-control bg-accent px-4 py-1.5 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer"
              >
                {t('crypto.smime.importIdentity')}
              </button>
            </div>
          )}
          {identityError && <span className="text-caption text-rose-600 dark:text-rose-400">{identityError}</span>}
        </div>

        {certs.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {certs.map((cert) => (
              <li
                key={cert.fingerprint}
                className="flex items-center gap-2 rounded-control border border-border bg-panel px-3 py-2"
              >
                <FileBadge size={15} className="shrink-0 text-secondary" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-semibold">
                    {cert.subject || cert.addresses[0] || t('crypto.unnamedKey')}
                  </span>
                  <span className="block truncate text-2xs text-secondary">
                    {cert.addresses.join(', ')}
                    {cert.addresses.length > 0 && ' · '}
                    <span className="font-mono">{grouped(cert.fingerprint)}</span>
                  </span>
                </div>
                <button
                  type="button"
                  title={t('crypto.removeKey')}
                  aria-label={t('crypto.removeKey')}
                  onClick={() => {
                    void confirmAction({
                      title: t('crypto.removeKeyTitle'),
                      message: t('crypto.removeKeyMessage', {
                        name: cert.subject || cert.fingerprint,
                      }),
                      confirmLabel: t('crypto.removeKey'),
                      cancelLabel: t('buttons.cancel'),
                      tone: 'danger',
                    }).then((yes) => {
                      if (yes) void removeSmimeCert(cert.fingerprint)
                    })
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-rose-500/10 hover:text-rose-500 cursor-pointer"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void add()}
            className="rounded-control bg-accent px-4 py-1.5 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('crypto.smime.importCert')}
          </button>
        </div>
      </div>
    </SettingsGroup>
  )
}
