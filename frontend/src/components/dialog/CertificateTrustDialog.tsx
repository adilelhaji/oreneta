import { ShieldAlert } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { certTrust$, dismissCertificatePrompt, trustPromptedCertificate } from '../../states/certificateTrust'
import { CertificateTrustPanel } from './CertificateTrustPanel'
import { Dialog } from './Dialog'

// The app-level certificate prompt: raised when an action on an existing
// account hits a server certificate we cannot validate — today, a send whose
// submission server was refused. Setup-time failures are handled inline by the
// account dialog instead, where the servers are already on screen.
//
// On the top layer, as an alert: nothing may cover a question about whether
// to trust a server, and nothing may answer it by accident.
export function CertificateTrustDialog() {
  const { t } = useTranslation()
  const prompt = useValue(certTrust$.prompt)
  const busy = useValue(certTrust$.busy)

  if (!prompt) return null

  return (
    <Dialog
      title={t('certificate.title', { defaultValue: 'Unverified server certificate' })}
      icon={ShieldAlert}
      layer="top"
      role="alertdialog"
      closeDisabled={busy}
      onClose={dismissCertificatePrompt}
    >
      <CertificateTrustPanel
        prompt={prompt}
        busy={busy}
        onTrust={trustPromptedCertificate}
        onDismiss={dismissCertificatePrompt}
      />
    </Dialog>
  )
}
