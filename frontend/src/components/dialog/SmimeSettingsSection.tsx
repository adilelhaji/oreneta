import { useEffect, useState } from 'react'
import { FileBadge, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { pickFileAsBase64 } from '../../lib/nativeFilePicker'
import { confirmAction, showToast } from '../../states/ui'
import { importSmimeCert, loadSmimeCerts, removeSmimeCert, smime$ } from '../../states/smime'
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
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!loaded) void loadSmimeCerts()
  }, [loaded])

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

  return (
    <SettingsGroup title={t('crypto.smime.title')}>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <p className="text-caption text-secondary">{t('crypto.smime.intro')}</p>

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
