import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { compose$ } from '../../states/compose'
import { keepThisVersion, localDrafts$ } from '../../states/localDraftSync'

// What became of the copy of this draft kept on this device (#170). Quiet
// while it is being kept; plain when it is not — an error says why, and a
// conflict stops autosave until the reader chooses to keep what they see.
export function LocalDraftStatus({ tabId }: { tabId: string }) {
  const { t } = useTranslation()
  const status = useValue(() => localDrafts$.status[tabId].get())
  if (!status) return null

  if (status.state === 'saving' || status.state === 'saved') {
    return (
      <p role="status" className="shrink-0 px-4 pb-1 text-caption text-secondary">
        {t(status.state === 'saving' ? 'composer.localDraft.saving' : 'composer.localDraft.saved')}
      </p>
    )
  }

  if (status.state === 'error') {
    return (
      <p role="alert" className="shrink-0 px-4 pb-1 wrap-anywhere text-caption font-medium text-danger">
        {t('composer.localDraft.error', { error: status.error ?? '' })}
      </p>
    )
  }

  const keep = () => {
    const tab = compose$.tabs.peek().find((candidate) => candidate.id === tabId)
    if (tab) void keepThisVersion(tab)
  }
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-1 text-caption font-medium text-danger"
    >
      <span className="wrap-anywhere">
        {t(status.conflict === 'discarded' ? 'composer.localDraft.discarded' : 'composer.localDraft.newer')}
      </span>
      {status.conflict !== 'discarded' && (
        <button
          type="button"
          onClick={keep}
          className="rounded-control px-2 py-1 text-xs font-semibold text-primary hover:bg-hover cursor-pointer"
        >
          {t('composer.localDraft.keepThis')}
        </button>
      )}
    </div>
  )
}
