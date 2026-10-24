import { ArrowLeft } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { ui$ } from '../../states/ui'
import { IconButton } from '../button/IconButton'

/**
 * Below 769 px, where there is no module strip and no narrow bar, the way back
 * to mail from another module. The modules, and what the rail's «Més» menu
 * offered, open from the band's app menu (owner decision 3 on #352).
 */
export function CompactNavigation() {
  const { t } = useTranslation()
  return (
    <div className="flex shrink-0 items-center gap-1 min-[769px]:hidden">
      <IconButton icon={ArrowLeft} label={t('chat.backToChats')} onClick={() => ui$.module.set('mail')} />
    </div>
  )
}
