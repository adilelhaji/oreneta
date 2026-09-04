import { KeyRound, ShieldCheck } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { Notice } from '../notice/Notice'

/**
 * What a message's own structure says was done to it.
 *
 * An encrypted message that nothing can read used to arrive as a blank page
 * with an attachment called `encrypted.asc` beside it, and the reader was left
 * to work out that anything had happened at all. This says what arrived.
 *
 * Careful about what it claims. "Signed" here means the message says it
 * carries a signature — not that the signature is good, which needs keys and
 * is a separate answer. Saying "signed" for an unverified signature is the one
 * mistake this must not make, because it is the mistake that makes a forgery
 * look authentic. So it reads as a claim until something has checked it.
 */
export function ProtectionNotice({ protection }: { protection?: string }) {
  const { t } = useTranslation()
  if (!protection || protection === 'none') return null

  const encrypted =
    protection === 'pgpEncrypted' || protection === 'pgpInline' || protection === 'smimeEnveloped'

  return (
    <Notice
      tone={encrypted ? 'info' : 'warning'}
      className="mb-2"
      title={encrypted ? t('crypto.encryptedTitle') : t('crypto.signedClaimTitle')}
    >
      <span className="flex items-start gap-1.5">
        {encrypted ? (
          <KeyRound size={13} className="mt-0.5 shrink-0" />
        ) : (
          <ShieldCheck size={13} className="mt-0.5 shrink-0" />
        )}
        <span>{encrypted ? t('crypto.encryptedText') : t('crypto.signedClaimText')}</span>
      </span>
    </Notice>
  )
}
