import { useEffect, useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { pairKey, type ModelPair } from '../../lib/translation'
import {
  cancelDownload,
  downloadErrorText,
  downloadModels,
  languageName,
  refreshTranslationStatus,
  removeModel,
  translationStatus$,
} from '../../states/translation'
import { showToast } from '../../states/ui'
import { formatFileSize } from '../chat/messageHelpers'
import { Button } from '../button/Button'
import { SettingsGroup } from './AccountSettingsRows'

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Translation models (#106, ADR-0031): which languages are here, how much
 * space they take, and downloading or removing one, which only happens when
 * asked.
 */
export function TranslationModelsGroup() {
  const { t } = useTranslation()
  const status = useValue(translationStatus$)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void refreshTranslationStatus()
  }, [])

  if (!status) return null

  const download = async (pair: ModelPair) => {
    const result = await downloadModels([pair], t)
    if (!result.ok && result.reason === 'failed' && result.error?.detail?.code !== 'cancelled')
      showToast(downloadErrorText(result.error, t), 'error')
  }

  const remove = async (pair: ModelPair) => {
    setBusy(pairKey(pair))
    try {
      await removeModel(pair)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsGroup title={t('translation.settingsTitle', { defaultValue: 'Translation' })}>
      <div className="flex flex-col gap-2 px-3.5 py-3 text-caption">
        <p className="text-secondary">
          {t('translation.settingsHint', {
            source: hostOf(status.source),
            defaultValue:
              'Messages are translated on this computer with Bergamot. A language’s model is downloaded from {source} only when you ask, checked, and then used without the network. Models are Mozilla’s, under the MPL-2.0 licence.',
          })}
        </p>
        <p className="text-primary">
          {t('translation.space', {
            used: formatFileSize(status.used),
            quota: formatFileSize(status.quota),
            defaultValue: 'Using {used} of {quota} allowed for models.',
          })}
        </p>
        <ul className="flex flex-col divide-y divide-border/40">
          {status.pairs.map((pair) => {
            const key = pairKey(pair)
            const progress = status.downloading[key]
            const label = `${languageName(pair.from)} → ${languageName(pair.to)}`
            return (
              <li key={key} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="min-w-[12rem] text-primary">{label}</span>
                <span className="text-secondary">{formatFileSize(pair.size)}</span>
                <span className="ml-auto flex items-center gap-2">
                  {progress ? (
                    <>
                      <progress
                        aria-label={t('translation.downloading', { model: label, defaultValue: 'Downloading {model}' })}
                        value={progress.done}
                        max={progress.total || pair.size}
                        className="w-28"
                      />
                      <Button size="sm" variant="secondary" onClick={() => void cancelDownload(pair)}>
                        {t('buttons.cancel')}
                      </Button>
                    </>
                  ) : pair.installed ? (
                    <Button size="sm" variant="secondary" disabled={busy === key} onClick={() => void remove(pair)}>
                      {t('translation.remove', { defaultValue: 'Remove' })}
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => void download(pair)}>
                      {t('translation.download', { defaultValue: 'Download' })}
                    </Button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </SettingsGroup>
  )
}
