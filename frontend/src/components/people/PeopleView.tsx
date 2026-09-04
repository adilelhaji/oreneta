import { useEffect } from 'react'
import { Building2, Copy, Mail, Phone, Search, SquarePen } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { accounts$, isSendableAccount } from '../../states/accounts'
import { openComposeTab } from '../../states/compose'
import { loadPeople, people$, sourceLabel } from '../../states/people'
import { showToast, ui$ } from '../../states/ui'
import type { Person } from '../../types'
import { Avatar } from '../avatar/Avatar'
import { EmptyState } from '../empty-state/EmptyState'
import { LoadingState } from '../empty-state/StateViews'
import { IconButton } from '../button/IconButton'

/**
 * The address book, as a place rather than as a dropdown.
 *
 * Two panes: everyone on the left, one person on the right. What the right
 * pane can do is exactly what the book knows — write to an address, dial
 * nothing but show the number, copy either — and it says where each person
 * came from, because a person from a CardDAV server and one from Google are
 * two rows on purpose and the reader should be able to tell which is which.
 *
 * Read-only, and it looks it: there is no edit button that turns out not to
 * save. Editing lives where the book does until writing back exists here.
 */
export function PeopleView() {
  const { t } = useTranslation()
  const people = useValue(people$.people)
  const loaded = useValue(people$.loaded)
  const loading = useValue(people$.loading)
  const query = useValue(people$.query)
  const selectedId = useValue(people$.selectedId)
  const accounts = useValue(accounts$)

  useEffect(() => {
    if (!loaded) void loadPeople()
  }, [loaded])

  // Searching re-asks the core rather than filtering what is loaded: the list
  // is capped, and a person past the cap would otherwise be unfindable.
  useEffect(() => {
    const timer = setTimeout(() => void loadPeople(query), 150)
    return () => clearTimeout(timer)
  }, [query])

  const selected = people.find((person) => person.id === selectedId) ?? null

  const writeTo = (person: Person, addr: string) => {
    // A book that belongs to an account writes from that account; one that
    // belongs to nobody writes from whichever can send.
    const owner = accounts.find((account) => account.id === person.account && isSendableAccount(account))
    const from = owner ?? accounts.find(isSendableAccount)
    if (!from) return
    ui$.peopleOpen.set(false)
    openComposeTab({ accountId: from.id, to: person.name ? `${person.name} <${addr}>` : addr })
  }

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => showToast(t('people.copied')))
  }

  return (
    <div className="flex min-h-0 flex-1 bg-app">
      <section className="flex w-80 shrink-0 flex-col border-r border-border bg-chats">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border px-3">
          <div className="flex flex-1 items-center gap-2 rounded-control bg-hover px-2.5 py-1.5 focus-within:bg-app">
            <Search size={14} className="shrink-0 text-secondary" />
            <input
              value={query}
              onChange={(event) => people$.query.set(event.target.value)}
              placeholder={t('people.search')}
              aria-label={t('people.search')}
              className="min-w-0 flex-1 bg-transparent text-ui text-primary placeholder-secondary outline-none"
            />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!loaded && loading ? (
            <LoadingState title={t('people.loading')} />
          ) : people.length === 0 ? (
            <EmptyState
              title={query ? t('people.noMatch') : t('people.emptyTitle')}
              text={query ? t('people.tryAnother') : t('people.emptyText')}
            />
          ) : (
            <ul role="listbox" aria-label={t('people.title')}>
              {people.map((person) => {
                const active = person.id === selectedId
                return (
                  <li key={person.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => people$.selectedId.set(person.id)}
                      className={clsx(
                        'flex w-full items-center gap-3 border-b border-border/50 px-3 py-2 text-left transition-colors cursor-pointer',
                        active ? 'bg-accent/20 dark:bg-accent/30' : 'hover:bg-hover',
                      )}
                    >
                      <Avatar
                        name={person.name}
                        email={person.emails[0]?.addr}
                        src={person.photo ? `/media/${person.photo}` : undefined}
                        size={34}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui font-semibold text-primary">{person.name}</span>
                        <span className="block truncate text-caption text-secondary">
                          {person.organisation || person.emails[0]?.addr || ''}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <PersonCard person={selected} onWrite={(addr) => writeTo(selected, addr)} onCopy={copy} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState title={t('people.pickSomeone')} text={t('people.pickSomeoneText')} />
          </div>
        )}
      </section>
    </div>
  )
}

function PersonCard({
  person,
  onWrite,
  onCopy,
}: {
  person: Person
  onWrite: (addr: string) => void
  onCopy: (text: string) => void
}) {
  const { t } = useTranslation()
  const source = sourceLabel(person.source)

  return (
    <div className="mx-auto w-full max-w-2xl px-8 py-10">
      <header className="flex items-center gap-5">
        <Avatar
          name={person.name}
          email={person.emails[0]?.addr}
          src={person.photo ? `/media/${person.photo}` : undefined}
          size={72}
        />
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold text-primary">{person.name}</h1>
          {person.organisation && (
            <p className="mt-0.5 flex items-center gap-1.5 text-ui text-secondary">
              <Building2 size={14} /> {person.organisation}
            </p>
          )}
          {/* Where they came from, as a fact rather than an icon. */}
          <p className="mt-1 text-caption text-secondary/80">{t(`people.source.${source}`)}</p>
        </div>
      </header>

      {person.emails.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-caption font-bold uppercase tracking-wide text-secondary">{t('people.emails')}</h2>
          <ul className="overflow-hidden rounded-control border border-border">
            {person.emails.map((email) => (
              <li
                key={email.addr}
                className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
              >
                <Mail size={14} className="shrink-0 text-secondary" />
                <span className="min-w-0 flex-1 truncate text-ui text-primary">{email.addr}</span>
                {email.label && <span className="shrink-0 text-caption text-secondary">{email.label}</span>}
                <IconButton icon={Copy} iconSize={13} size="sm" label={t('people.copy')} onClick={() => onCopy(email.addr)} />
                <IconButton
                  icon={SquarePen}
                  iconSize={13}
                  size="sm"
                  label={t('people.writeTo', { addr: email.addr })}
                  onClick={() => onWrite(email.addr)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {person.phones.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-caption font-bold uppercase tracking-wide text-secondary">{t('people.phones')}</h2>
          <ul className="overflow-hidden rounded-control border border-border">
            {person.phones.map((phone) => (
              <li
                key={phone.number}
                className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
              >
                <Phone size={14} className="shrink-0 text-secondary" />
                <span className="min-w-0 flex-1 truncate text-ui text-primary tabular-nums">{phone.number}</span>
                {phone.label && <span className="shrink-0 text-caption text-secondary">{phone.label}</span>}
                <IconButton icon={Copy} iconSize={13} size="sm" label={t('people.copy')} onClick={() => onCopy(phone.number)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {person.note && (
        <section className="mt-6">
          <h2 className="mb-2 text-caption font-bold uppercase tracking-wide text-secondary">{t('people.note')}</h2>
          <p className="whitespace-pre-wrap text-ui leading-relaxed text-primary">{person.note}</p>
        </section>
      )}
    </div>
  )
}
