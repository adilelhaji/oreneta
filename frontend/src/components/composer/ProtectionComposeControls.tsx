import { useEffect } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { loadCerts, loadSecretKeys, pgp$, secretKeys$ } from '../../states/pgp'
import { loadSmimeCerts, loadSmimeIdentities, smime$, smimeIdentities$ } from '../../states/smime'

/**
 * Sign and encrypt, offered where sending happens.
 *
 * Two toggles rather than one "protect this" switch, because they answer
 * different questions and a reader may want either alone: signing says who
 * this really is from, encrypting says who else can read it. Sending a
 * message that claims to be signed by an unlocked key nobody can check is a
 * worse mistake than a plain message, so the toggles disable themselves when
 * there is nothing to sign or encrypt with, rather than failing at send time.
 *
 * One pair of toggles for both protocols, not a protocol picker: which of
 * OpenPGP or S/MIME actually protects the message is decided automatically,
 * server-side, the moment sending happens (S/MIME when it alone can cover
 * the sender and every recipient, OpenPGP otherwise — see perform_send in
 * meron-core). So a toggle here is enabled the moment *either* protocol
 * could do the job, not only when OpenPGP specifically can.
 */
export function ProtectionComposeControls({
  sign,
  encrypt,
  passphrase,
  onSignChange,
  onEncryptChange,
  onPassphraseChange,
}: {
  sign: boolean
  encrypt: boolean
  passphrase: string
  onSignChange: (value: boolean) => void
  onEncryptChange: (value: boolean) => void
  onPassphraseChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const secretKeys = useValue(secretKeys$.keys)
  const secretLoaded = useValue(secretKeys$.loaded)
  const certs = useValue(pgp$.certs)
  const certsLoaded = useValue(pgp$.loaded)
  const smimeIdentities = useValue(smimeIdentities$.identities)
  const smimeIdentitiesLoaded = useValue(smimeIdentities$.loaded)
  const smimeCerts = useValue(smime$.certs)
  const smimeCertsLoaded = useValue(smime$.loaded)

  useEffect(() => {
    if (!secretLoaded) void loadSecretKeys()
    if (!certsLoaded) void loadCerts()
    if (!smimeIdentitiesLoaded) void loadSmimeIdentities()
    if (!smimeCertsLoaded) void loadSmimeCerts()
  }, [secretLoaded, certsLoaded, smimeIdentitiesLoaded, smimeCertsLoaded])

  const canSign = secretKeys.length > 0 || smimeIdentities.length > 0
  const canEncrypt = certs.length > 0 || smimeCerts.length > 0
  // A key held but not yet unlocked for this send. S/MIME identities never
  // need this: their private key is unlocked once, at import, not per send.
  const signingKeyLocked = sign && secretKeys.some((key) => key.protected) && !passphrase

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={!canSign}
        title={canSign ? t('crypto.signMessage') : t('crypto.noKeyToSign')}
        aria-pressed={sign}
        onClick={() => onSignChange(!sign)}
        className={`flex h-8 w-8 items-center justify-center rounded-control transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 ${
          sign ? 'bg-accent/15 text-accent' : 'text-secondary hover:bg-hover'
        }`}
      >
        <ShieldCheck size={15} />
      </button>
      <button
        type="button"
        disabled={!canEncrypt}
        title={canEncrypt ? t('crypto.encryptMessage') : t('crypto.noKeyToEncrypt')}
        aria-pressed={encrypt}
        onClick={() => onEncryptChange(!encrypt)}
        className={`flex h-8 w-8 items-center justify-center rounded-control transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 ${
          encrypt ? 'bg-accent/15 text-accent' : 'text-secondary hover:bg-hover'
        }`}
      >
        <KeyRound size={15} />
      </button>
      {signingKeyLocked && (
        <input
          type="password"
          value={passphrase}
          onChange={(event) => onPassphraseChange(event.target.value)}
          placeholder={t('crypto.passphrasePlaceholder')}
          aria-label={t('crypto.passphrasePlaceholder')}
          autoComplete="off"
          className="w-36 rounded-control border border-border bg-app px-2 py-1 text-caption text-primary placeholder-secondary outline-none focus:border-accent/50"
        />
      )}
    </div>
  )
}
