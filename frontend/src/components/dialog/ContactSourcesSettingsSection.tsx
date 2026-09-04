import { useEffect, useState } from 'react'
import { BookUser, RefreshCw, Trash2 } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { accounts$ } from '../../states/accounts'
import { confirmAction, showToast } from '../../states/ui'
import {
  addBook,
  contactSources$,
  discoverBooks,
  loadContactSources,
  removeSource,
  syncGoogleContacts,
  syncSource,
  type DiscoveredBook,
} from '../../states/contactSources'
import { SettingsGroup } from './AccountSettingsRows'
import { TextInput } from '../field/Field'

/**
 * Address books the app reads people from.
 *
 * Two steps, because that is how many there are: say where and who, then
 * choose which of the books found to keep. A server usually has one and the
 * choice is instant; when it has several — work, family, shared — picking is
 * the point, and guessing would put the wrong people in the composer.
 *
 * The password is sent for discovery and again when a book is added, and
 * then it lives in the OS keyring. It is never in this component's state
 * for longer than the two steps take, and never in the store.
 */
export function ContactSourcesSettingsSection() {
  const { t } = useTranslation()
  const sources = useValue(contactSources$.sources)
  const loaded = useValue(contactSources$.loaded)
  const accounts = useValue(accounts$)
  // Google accounts whose contacts have not been brought in yet. Once one has,
  // it appears in the list above with the others and is re-read from there.
  const googleWithout = accounts.filter(
    (account) =>
      account.auth_type === 'gmail_oauth' && !sources.some((source) => source.id === `google-${account.id}`),
  )

  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [books, setBooks] = useState<DiscoveredBook[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!loaded) void loadContactSources()
  }, [loaded])

  const reset = () => {
    setServer('')
    setUsername('')
    setPassword('')
    setBooks(null)
  }

  const find = async () => {
    setBusy(true)
    try {
      const found = await discoverBooks(server, username, password)
      setBooks(found)
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('contacts.discoverFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const keep = async (book: DiscoveredBook) => {
    setBusy(true)
    try {
      const problem = await addBook(book, username, password)
      if (problem) showToast(problem, 'error')
      else showToast(t('contacts.added', { name: book.name }))
      reset()
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('contacts.addFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsGroup title={t('contacts.title')}>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <p className="text-caption text-secondary">{t('contacts.intro')}</p>

        {sources.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {sources.map((source) => (
              <li
                key={source.id}
                className="flex items-center gap-2 rounded-control border border-border bg-panel px-3 py-2"
              >
                <BookUser size={15} className="shrink-0 text-secondary" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-semibold">{source.name || source.url}</span>
                  {/* What went wrong, where it went wrong, rather than a red
                      dot somewhere else. */}
                  <span
                    className={`block truncate text-caption ${source.lastError ? 'text-rose-600 dark:text-rose-400' : 'text-secondary'}`}
                  >
                    {source.lastError
                      ? source.lastError
                      : source.lastSyncAt
                        ? t('contacts.lastSynced', { when: new Date(source.lastSyncAt * 1000).toLocaleString() })
                        : t('contacts.neverSynced')}
                  </span>
                </div>
                <button
                  type="button"
                  title={t('contacts.syncNow')}
                  aria-label={t('contacts.syncNow')}
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    void syncSource(source.id)
                      .then((problem) => {
                        if (problem) showToast(problem, 'error')
                      })
                      .finally(() => setBusy(false))
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-hover hover:text-primary cursor-pointer disabled:opacity-40"
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  type="button"
                  title={t('contacts.remove')}
                  aria-label={t('contacts.remove')}
                  disabled={busy}
                  onClick={() => {
                    void confirmAction({
                      title: t('contacts.removeTitle'),
                      message: t('contacts.removeMessage', { name: source.name || source.url }),
                      confirmLabel: t('contacts.remove'),
                      cancelLabel: t('buttons.cancel'),
                      tone: 'danger',
                    }).then((yes) => {
                      if (yes) void removeSource(source.id)
                    })
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control-sm text-secondary transition-colors hover:bg-rose-500/10 hover:text-rose-500 cursor-pointer disabled:opacity-40"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {googleWithout.map((account) => (
          <div
            key={account.id}
            className="flex items-center justify-between gap-2 rounded-control border border-border bg-panel px-3 py-2"
          >
            <span className="min-w-0 truncate text-ui text-primary">{account.email}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void syncGoogleContacts(account.id, account.email)
                  .then((problem) => {
                    if (problem) showToast(problem, 'error')
                    else showToast(t('contacts.added', { name: account.email }))
                  })
                  .catch((error) => showToast(error instanceof Error ? error.message : t('contacts.addFailed'), 'error'))
                  .finally(() => setBusy(false))
              }}
              className="shrink-0 rounded-control px-3 py-1.5 text-caption font-semibold text-accent transition-colors hover:bg-accent/10 cursor-pointer disabled:opacity-50"
            >
              {t('contacts.readGoogle')}
            </button>
          </div>
        ))}

        {books === null ? (
          <form
            className="flex flex-col gap-2 rounded-control border border-border bg-panel px-3 py-2.5"
            onSubmit={(event) => {
              event.preventDefault()
              void find()
            }}
          >
            <span className="text-caption font-semibold text-secondary">{t('contacts.addCardDav')}</span>
            <TextInput
              value={server}
              onChange={(event) => setServer(event.target.value)}
              placeholder={t('contacts.serverPlaceholder')}
              autoComplete="off"
            />
            <div className="flex gap-2">
              <TextInput
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={t('contacts.usernamePlaceholder')}
                autoComplete="off"
                className="min-w-0 flex-1"
              />
              <TextInput
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t('contacts.passwordPlaceholder')}
                autoComplete="new-password"
                className="min-w-0 flex-1"
              />
            </div>
            <div>
              <button
                type="submit"
                disabled={busy || !server.trim()}
                className="rounded-control bg-accent px-4 py-1.5 text-caption font-bold text-white transition-colors hover:bg-accent-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? t('common.loading') : t('contacts.findBooks')}
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2 rounded-control border border-border bg-panel px-3 py-2.5">
            <span className="text-caption font-semibold text-secondary">{t('contacts.chooseBook')}</span>
            {books.map((book) => (
              <button
                key={book.url}
                type="button"
                disabled={busy}
                onClick={() => void keep(book)}
                className="flex items-center justify-between gap-2 rounded-control-sm px-2 py-1.5 text-left text-ui transition-colors hover:bg-hover cursor-pointer disabled:opacity-50"
              >
                <span className="truncate font-semibold text-primary">{book.name}</span>
                <span className="truncate text-caption text-secondary">{book.url}</span>
              </button>
            ))}
            <div>
              <button
                type="button"
                onClick={reset}
                className="rounded-control px-3 py-1.5 text-caption font-semibold text-secondary transition-colors hover:bg-hover cursor-pointer"
              >
                {t('buttons.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </SettingsGroup>
  )
}
