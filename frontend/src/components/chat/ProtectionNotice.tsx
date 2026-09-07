import { useEffect, useState } from 'react'
import { KeyRound, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { decryptMessage, verifyMessage, type DecryptResult } from '../../states/pgp'
import { decryptSmimeMessage, verifySmimeMessage } from '../../states/smime'
import type { SignatureResult } from '../../states/signatureVerdict'
import type { Message } from '../../types'
import { Notice } from '../notice/Notice'

/**
 * What a message's structure says was done to it, and — for a signature —
 * what checking it actually concluded.
 *
 * The claim appears at once, because it comes free with the message. The
 * verdict replaces it a moment later, because checking a signature means
 * fetching the message as it stood on the wire and that is a round trip. Until
 * it lands the notice says the message *claims* a signature, which is true and
 * is not the same as saying it has one.
 *
 * The four verdicts are kept apart on purpose. "Nothing here can check it" is
 * not "this is forged", and reporting the second for the first is crying wolf
 * until nobody reads the warning. A good signature from an address other than
 * the sender's is called out on its own: the cryptography is impeccable and
 * the message is still not from who it says.
 */
export function ProtectionNotice({ message }: { message: Message }) {
  const { t } = useTranslation()
  const protection = message.protection
  const [result, setResult] = useState<SignatureResult | null>(null)
  const [opened, setOpened] = useState<{ body: string } | null>(null)
  const [needsPassphrase, setNeedsPassphrase] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const claimsSignature =
    protection === 'pgpSigned' ||
    protection === 'pgpInline' ||
    protection === 'smimeSigned' ||
    protection === 'smimeOpaqueSigned'
  // Both PGP shapes go through the OpenPGP verifier; both S/MIME shapes
  // (detached and Outlook's opaque default) go through the same S/MIME one —
  // the shape only changes which bytes get fetched, not which cryptography
  // checks them.
  const verify =
    protection === 'pgpSigned'
      ? verifyMessage
      : protection === 'smimeSigned' || protection === 'smimeOpaqueSigned'
        ? verifySmimeMessage
        : null

  useEffect(() => {
    setResult(null)
    if (!verify || !message.account_id || !message.folder_id) return
    const uid = Number(message.id.split('#').pop())
    if (!Number.isFinite(uid) || uid <= 0) return
    let live = true
    void verify(message.account_id, message.folder_id, uid)
      .then((answer) => {
        if (live) setResult(answer)
      })
      .catch(() => {
        // A check that could not run is not a verdict. The claim stands.
      })
    return () => {
      live = false
    }
  }, [message.id, message.account_id, message.folder_id, verify])

  if (!protection || protection === 'none') return null

  const encrypted =
    protection === 'pgpEncrypted' || protection === 'pgpInline' || protection === 'smimeEnveloped'
  const isSmimeEncrypted = protection === 'smimeEnveloped'

  if (encrypted) {
    const uid = Number(message.id.split('#').pop())
    const canOpen = !!message.account_id && !!message.folder_id && Number.isFinite(uid) && uid > 0

    const open = () => {
      setBusy(true)
      setFailure(null)
      // S/MIME never needs a passphrase here: the identity's private key was
      // unlocked once, at import, so there is nothing left to ask for beyond
      // whether one is held at all.
      const opening = isSmimeEncrypted
        ? decryptSmimeMessage(message.account_id, message.folder_id, uid)
        : decryptMessage(message.account_id, message.folder_id, uid, passphrase || undefined)
      void opening
        .then((answer: DecryptResult) => {
          if (answer.ok) {
            setOpened({ body: answer.body })
            setNeedsPassphrase(false)
            // Not kept a moment longer than the message it opened.
            setPassphrase('')
            return
          }
          if (answer.failure.reason === 'needsPassphrase') {
            setNeedsPassphrase(true)
            setFailure(passphrase ? t('crypto.wrongPassphrase') : null)
            return
          }
          setFailure(t(`crypto.failure.${answer.failure.reason}`))
        })
        .catch((error) => setFailure(error instanceof Error ? error.message : t('crypto.failure.malformed')))
        .finally(() => setBusy(false))
    }

    return (
      <>
        <Notice
          tone="info"
          className="mb-2"
          title={t('crypto.encryptedTitle')}
          action={
            canOpen && !opened ? (
              <button
                type="button"
                disabled={busy}
                onClick={open}
                className="shrink-0 rounded-control bg-accent px-3 py-1 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer disabled:opacity-50"
              >
                {busy ? t('common.loading') : t('crypto.openIt')}
              </button>
            ) : undefined
          }
        >
          <span className="flex items-start gap-1.5">
            <KeyRound size={13} className="mt-0.5 shrink-0" />
            <span>{opened ? t('crypto.openedText') : t('crypto.encryptedTextWithKeys')}</span>
          </span>
          {needsPassphrase && !opened && (
            <form
              className="mt-2 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                open()
              }}
            >
              <input
                type="password"
                value={passphrase}
                autoFocus
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder={t('crypto.passphrasePlaceholder')}
                aria-label={t('crypto.passphrasePlaceholder')}
                autoComplete="off"
                className="min-w-0 flex-1 rounded-control border border-border bg-app px-2.5 py-1 text-ui text-primary placeholder-secondary outline-none focus:border-accent/50"
              />
              <button
                type="submit"
                disabled={busy || !passphrase}
                className="shrink-0 rounded-control bg-accent px-3 py-1 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer disabled:opacity-50"
              >
                {t('crypto.openIt')}
              </button>
            </form>
          )}
          {failure && <span className="mt-1 block text-caption text-rose-600 dark:text-rose-400">{failure}</span>}
        </Notice>
        {opened && (
          <div className="mb-2 whitespace-pre-wrap rounded-control border border-accent/30 bg-accent/[0.04] px-3 py-2 text-ui leading-relaxed text-primary">
            {opened.body}
          </div>
        )}
      </>
    )
  }

  if (!claimsSignature) return null

  // Checked out, but signed by somebody other than the sender: worth more
  // alarm than an unchecked signature, not less — true whether or not the
  // certificate that did it is one already trusted.
  if (
    (result?.verdict === 'good' || result?.verdict === 'validUntrusted') &&
    result.matchesSender === false
  ) {
    return (
      <Notice tone="danger" className="mb-2" title={t('crypto.wrongSignerTitle')}>
        <span className="flex items-start gap-1.5">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          <span>{t('crypto.wrongSignerText', { signer: result.addresses[0] ?? '' })}</span>
        </span>
      </Notice>
    )
  }

  if (result?.verdict === 'good') {
    return (
      <Notice tone="success" className="mb-2" title={t('crypto.verifiedTitle')}>
        <span className="flex items-start gap-1.5">
          <ShieldCheck size={13} className="mt-0.5 shrink-0" />
          <span>{t('crypto.verifiedText', { signer: result.addresses[0] ?? '' })}</span>
        </span>
      </Notice>
    )
  }

  // S/MIME only: the signature is cryptographically real, made with the
  // certificate the message itself carries — and that certificate is not one
  // this reader has chosen to trust. Neither "good" (nobody vouched for it)
  // nor "no key" (something here was genuinely checked) fits.
  if (result?.verdict === 'validUntrusted') {
    return (
      <Notice tone="warning" className="mb-2" title={t('crypto.validUntrustedTitle')}>
        <span className="flex items-start gap-1.5">
          <ShieldQuestion size={13} className="mt-0.5 shrink-0" />
          <span>{t('crypto.validUntrustedText', { signer: result.addresses[0] ?? '' })}</span>
        </span>
      </Notice>
    )
  }

  if (result?.verdict === 'bad') {
    return (
      <Notice tone="danger" className="mb-2" title={t('crypto.badTitle')}>
        <span className="flex items-start gap-1.5">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          <span>{t('crypto.badText')}</span>
        </span>
      </Notice>
    )
  }

  if (result?.verdict === 'noKey') {
    return (
      <Notice tone="warning" className="mb-2" title={t('crypto.noKeyTitle')}>
        <span className="flex items-start gap-1.5">
          <ShieldQuestion size={13} className="mt-0.5 shrink-0" />
          <span>{t('crypto.noKeyText')}</span>
        </span>
      </Notice>
    )
  }

  return (
    <Notice tone="warning" className="mb-2" title={t('crypto.signedClaimTitle')}>
      <span className="flex items-start gap-1.5">
        <ShieldQuestion size={13} className="mt-0.5 shrink-0" />
        <span>{t('crypto.signedClaimText')}</span>
      </span>
    </Notice>
  )
}
