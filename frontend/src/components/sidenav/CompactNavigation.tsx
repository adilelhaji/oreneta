import { useRef, useState } from 'react'
import { ArrowLeft, MoreHorizontal } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { ui$ } from '../../states/ui'
import { IconButton } from '../button/IconButton'
import { QuickSettingsMenu } from './QuickSettingsMenu'

/** Keep the existing app menu reachable while the account rail is hidden. */
export function CompactNavigation() {
  const { t } = useTranslation()
  const [anchor, setAnchor] = useState<{ x: number; y: number; placement: 'down' } | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  return (
    <div className="flex shrink-0 items-center gap-1 min-[769px]:hidden">
      <IconButton
        icon={ArrowLeft}
        label={t('chat.backToChats')}
        onClick={() => {
          ui$.calendarOpen.set(false)
          ui$.peopleOpen.set(false)
          ui$.tasksOpen.set(false)
        }}
      />
      <IconButton
        ref={opener}
        icon={MoreHorizontal}
        label={t('common.more')}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.left, y: rect.bottom, placement: 'down' })
        }}
      />
      {anchor && (
        <QuickSettingsMenu
          anchor={anchor}
          onClose={() => {
            setAnchor(null)
            opener.current?.focus()
          }}
        />
      )}
    </div>
  )
}
