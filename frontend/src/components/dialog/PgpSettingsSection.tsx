import { useEffect, useState } from 'react'
import { KeyRound, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { confirmAction, showToast } from '../../states/ui'
import { importCert, loadCerts, pgp$, removeCert } from '../../states/pgp'
import { SettingsGroup } from './AccountSettingsRows'

/** Fingerprints are read four characters at a time, or not at all. */
function grouped(fingerprint: string): string {
  return (fingerprint.match(/.{1,4}/g) ?? [fingerprint]).join(' ')
}

/**
 * The OpenPGP certificates used to check signatures.
 *
 * Public certificates only, and the screen says so: a reader who expects to
 * decrypt after importing a key here should find that out now rather than
 * from a message that will not open.
 *
 * Pasting rather than a file picker, because that is how a public key
 * actually travels — in the body of a mail, on a web page, out of another
 * client's export button.
 */
export function PgpSettingsSection() {
  const { t } = useTranslation()
  const certs = useValue(pgp$.certs)
  const loaded = useValue(pgp$.loaded)
  const [armoured, setArmoured] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!loaded) void loadCerts()
  }, [loaded])

  const add = async () => {
    setBusy(true)
    try {
      const fingerprint = await importCert(armoured)
      setArmoured('')
      showToast(t('crypto.imported', { fingerprint: grouped(fingerprint.slice(-16)) }))
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('crypto.importFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsGroup title={t('crypto.title')}>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <p className="text-caption text-secondary">{t('crypto.intro')}</p>

        {certs.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {certs.map((cert) => (
              <li
                key={cert.fingerprint}
                className="flex items-center gap-2 rounded-control border border-border bg-panel px-3 py-2"
              >
                <KeyRound size={15} className="shrink-0 text-secondary" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-semibold">
                    {cert.userIds[0] || cert.addresses[0] || t('crypto.unnamedKey')}
                  </span>
                  <span className="block truncate font-mono text-2xs text-secondary">
                    {grouped(cert.fingerprint)}
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
                        name: cert.userIds[0] || cert.fingerprint,
                      }),
                      confirmLabel: t('crypto.removeKey'),
                      cancelLabel: t('buttons.cancel'),
                      tone: 'danger',
                    }).then((yes) => {
                      if (yes) void removeCert(cert.fingerprint)
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

        <div className="flex flex-col gap-2 rounded-control border border-border bg-panel px-3 py-2.5">
          <span className="text-caption font-semibold text-secondary">{t('crypto.importKey')}</span>
          <textarea
            value={armoured}
            onChange={(event) => setArmoured(event.target.value)}
            placeholder={t('crypto.importPlaceholder')}
            aria-label={t('crypto.importKey')}
            rows={4}
            spellCheck={false}
            className="w-full resize-y rounded-control border border-border bg-app px-2.5 py-1.5 font-mono text-2xs text-primary placeholder-secondary outline-none focus:border-accent/50"
          />
          <div>
            <button
              type="button"
              disabled={busy || !armoured.trim()}
              onClick={() => void add()}
              className="rounded-control bg-accent px-4 py-1.5 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('crypto.importKey')}
            </button>
          </div>
        </div>
      </div>
    </SettingsGroup>
  )
}
