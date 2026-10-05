import { useValue } from '@legendapp/state/react'
import { useId } from 'react'
import { useTranslation } from '../../lib/i18n'
import { DEFAULT_FONT_SCALE, MAX_MESSAGE_FONT_SCALE, MIN_FONT_SCALE } from '../../lib/fonts'
import { settings$ } from '../../states/settings'
import { Button } from '../button/Button'
import { SelectInput } from '../field/Field'

/** A direct entry to the existing body-only preference; no separate reader state. */
export function ReaderTextSize() {
  const { t } = useTranslation()
  const id = useId()
  const scale = useValue(settings$.messageFontScale)
  // Preserve arbitrary valid values entered in Settings, not just these presets.
  const choices = [...new Set([80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, scale])].sort((a, b) => a - b)
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-header px-3 py-1 text-caption text-secondary">
      <label htmlFor={id}>{t('settings.appearance.messageTextSize')}</label>
      <SelectInput
        id={id}
        fieldSize="sm"
        value={scale}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next) && next >= MIN_FONT_SCALE && next <= MAX_MESSAGE_FONT_SCALE) {
            settings$.messageFontScale.set(next)
          }
        }}
      >
        {choices.map((value) => (
          <option key={value} value={value}>
            {value}%
          </option>
        ))}
      </SelectInput>
      <Button
        size="sm"
        variant="ghost"
        disabled={scale === DEFAULT_FONT_SCALE}
        onClick={() => settings$.messageFontScale.set(DEFAULT_FONT_SCALE)}
      >
        {t('common.resetToDefault')}
      </Button>
    </div>
  )
}
