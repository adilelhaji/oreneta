import { ExternalLink, Heart, Info, ScrollText } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { ui$ } from '../../states/ui'
import { openExternal } from '../../lib/native'
import { Button } from '../button/Button'
import { UpdateSection } from './UpdateSection'
import { Dialog } from './Dialog'
import logo from '../../assets/logo.png'
import wailsConfig from '../../../../wails.json'

const DONATE_LINKS = [
  { label: 'GitHub', url: 'https://github.com/sponsors/nonbili' },
  { label: 'Liberapay', url: 'https://liberapay.com/rnons' },
  { label: 'PayPal', url: 'https://paypal.me/nonbili' },
]

const SOURCE_URL = 'https://github.com/adilelhaji/oreneta'

export function AboutDialog() {
  const { t } = useTranslation()
  const open = useValue(ui$.aboutOpen)

  const onClose = () => ui$.aboutOpen.set(false)

  if (!open) return null

  const productName = wailsConfig.info.productName
  const version = wailsConfig.info.productVersion
  const comments = wailsConfig.info.comments

  return (
    <Dialog title={t('about.aboutProduct', { product: productName })} icon={Info} width="sm" onClose={onClose}>
      <div className="flex flex-col items-center py-2 text-center">
        <img src={logo} alt="" className="h-20 w-20 object-contain" />
        <h3 className="mt-4 text-xl font-bold tracking-tight">{productName}</h3>
        <p className="mt-1 text-xs font-semibold text-secondary tabular-nums">{t('about.version', { version })}</p>
        <p className="mt-4 max-w-[18rem] text-sm leading-6 text-secondary">{comments}</p>
        {/* The lineage, stated where the app says what it is: Oreneta is a
            fork, and Meron's authors wrote most of what runs here. */}
        <p className="mt-2 max-w-[18rem] text-xs leading-5 text-secondary">
          {t('about.forkOf', { defaultValue: 'Based on Meron by Nonbili Inc., under the AGPL-3.0 license.' })}
        </p>

        <div className="mt-5 flex items-center gap-2">
          <Button variant="secondary" size="sm" rightIcon={ExternalLink} onClick={() => openExternal(SOURCE_URL)}>
            {t('about.sourceCode')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={ScrollText}
            onClick={() => {
              ui$.aboutOpen.set(false)
              ui$.changelogOpen.set(true)
            }}
          >
            {t('changelog.title')}
          </Button>
        </div>

        <UpdateSection />

        <div className="mt-6 w-full rounded-panel border border-border/70 bg-raised/70 p-4">
          <div className="flex items-center justify-center gap-2 text-xs font-bold text-primary">
            <Heart size={14} className="text-accent" />
            <span>{t('about.supportDevelopment')}</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {DONATE_LINKS.map((link) => (
              <Button
                key={link.url}
                variant="secondary"
                size="sm"
                rightIcon={ExternalLink}
                className="px-2 text-2xs"
                onClick={() => openExternal(link.url)}
              >
                {link.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
