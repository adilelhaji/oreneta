import { Sparkles } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { assistant$ } from '../../states/assistant'
import { SelectRow, SettingRow, SettingsGroup, TextRow } from './AccountSettingsRows'

export function AssistantSettingsSection() {
  const { t } = useTranslation()
  const mode = useValue(assistant$.mode)
  const endpoint = useValue(assistant$.endpoint)
  const model = useValue(assistant$.model)
  const local = mode === 'local'

  return (
    <SettingsGroup title={t('settings.assistant.title', { defaultValue: 'Assistant privacy' })}>
      <SelectRow
        icon={<Sparkles size={15} />}
        title={t('settings.assistant.mode', { defaultValue: 'Provider mode' })}
        hint={t('settings.assistant.modeHint', {
          defaultValue: 'Local mode never leaves this device. Remote mode sends only the context you review and confirm.',
        })}
        value={mode}
        options={[
          { value: 'local', label: t('settings.assistant.local', { defaultValue: 'Local-first' }) },
          { value: 'remote', label: t('settings.assistant.remote', { defaultValue: 'Remote, explicit' }) },
        ]}
        onChange={(value) => assistant$.mode.set(value === 'remote' ? 'remote' : 'local')}
      />
      <TextRow
        title={t('settings.assistant.endpoint', { defaultValue: 'Provider endpoint' })}
        hint={t('settings.assistant.endpointHint', {
          defaultValue: local ? 'Use a loopback HTTP(S) endpoint for a local runtime.' : 'Remote endpoints must use HTTPS.',
        })}
        value={endpoint}
        placeholder={local ? 'http://127.0.0.1:11434/v1' : 'https://provider.example/v1'}
        onChange={(value) => assistant$.endpoint.set(value)}
      />
      <TextRow
        title={t('settings.assistant.model', { defaultValue: 'Model identifier' })}
        hint={t('settings.assistant.modelHint', { defaultValue: 'The model is selected per provider; credentials are supplied only for an active request.' })}
        value={model}
        placeholder={t('settings.assistant.modelPlaceholder', { defaultValue: 'Optional until configured' })}
        onChange={(value) => assistant$.model.set(value)}
      />
      <SettingRow
        title={t('settings.assistant.safety', { defaultValue: 'Safety boundary' })}
        hint={t('settings.assistant.safetyHint', {
          defaultValue: 'Mail is untrusted input. Assistant actions can suggest text or tasks, never send, delete, move or change rules.',
        })}
        control={<span className="text-caption font-semibold text-secondary">{t('settings.assistant.reviewRequired', { defaultValue: 'Review required' })}</span>}
      />
    </SettingsGroup>
  )
}

