import { useState } from 'react'
import { Rss, RefreshCw } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { showToast } from '../../states/ui'
import { submitFeed } from '../../states/feeds'
import { ui$ } from '../../states/ui'
import { accounts$ } from '../../states/accounts'
import { Button } from '../button/Button'
import { TextInput } from '../field/Field'
import { Dialog } from './Dialog'

export function AddFeedDialog() {
  const { t } = useTranslation()
  const accountId = useValue(ui$.addFeedAccount)
  const accounts = useValue(accounts$)
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const account = accounts.find((acc) => acc.id === accountId)
  const accountName = account?.display_name || account?.email || t('accounts.thisAccount')

  const onClose = () => {
    if (loading) return
    ui$.addFeedAccount.set('')
  }

  const submit = async () => {
    const trimmed = url.trim()
    if (!trimmed || loading) return
    setLoading(true)
    setError('')
    try {
      await submitFeed(accountId, trimmed)
      showToast(t('feeds.added'))
      ui$.addFeedAccount.set('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('feeds.addFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog
      title={t('feeds.actions.addFeed')}
      subtitle={t('feeds.subscribeUnder', { account: accountName })}
      icon={Rss}
      onClose={onClose}
      closeDisabled={loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {t('buttons.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={loading || !url.trim()}>
            {loading && <RefreshCw size={11} className="animate-spin" />}
            <span>{t('feeds.actions.addFeed')}</span>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <label htmlFor="add-feed-url" className="px-1 text-caption font-semibold text-secondary">
          {t('feeds.url')}
        </label>
        <TextInput
          id="add-feed-url"
          autoFocus
          fieldSize="lg"
          surface="hover"
          value={url}
          invalid={!!error}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
          placeholder="https://example.com/feed.xml"
        />
        <p className="px-1 text-caption font-medium leading-relaxed text-secondary">{t('feeds.urlHint')}</p>
        {error && (
          <p role="alert" className="px-1 text-caption font-medium text-rose-500">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
