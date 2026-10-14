import { useState } from 'react'
import { useValue } from '@legendapp/state/react'
import { CalendarDays, Cloud, HardDrive, Link2, Server } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import {
  accountSupportsCalendar,
  addCalDav,
  createCalendar,
  discoverCalDav,
  type RemoteCalendar,
  createLocalCalendar,
  subscribeCalendar,
  type CalendarKind,
} from '../../states/calendar'
import { accounts$ } from '../../states/accounts'
import { isRssAccount } from '../../lib/threadActions'
import { Button } from '../button/Button'
import { SelectInput, TextInput } from '../field/Field'
import { Notice } from '../notice/Notice'
import { Dialog } from './Dialog'
import { isSubscriptionUrl } from '../../lib/subscriptionUrl'

/// Creating a calendar, asking first where it should live.
///
/// The order of the question follows what established calendar apps do: where
/// a calendar lives decides how it syncs and whether it can be edited, so it
/// is asked before anything else rather than inferred from which fields got
/// filled in.
export function NewCalendarDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const accounts = useValue(accounts$).filter(
    (account) => !isRssAccount(account, account.id) && account.auth_type !== 'graph_oauth',
  )
  // Only an account whose server keeps calendars can host a new one; a plain
  // IMAP account has nowhere to put it. Local calendars and subscriptions are
  // merely *listed under* an account, so any account can take those.
  const capable = accounts.filter(accountSupportsCalendar)
  const [kind, setKind] = useState<CalendarKind>(capable.length > 0 ? 'account' : 'local')
  const [accountId, setAccountId] = useState(capable[0]?.id ?? accounts[0]?.id ?? '')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [found, setFound] = useState<RemoteCalendar[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])

  const pool = kind === 'account' ? capable : accounts
  const chosen = pool.some((account) => account.id === accountId) ? accountId : (pool[0]?.id ?? '')

  const invalid =
    kind === 'caldav'
      ? !chosen || !server.trim() || (found !== null && picked.length === 0)
      : !name.trim() || !chosen || (kind === 'subscribed' && !isSubscriptionUrl(url))

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      if (kind === 'caldav') {
        // First the server is asked what it holds; then the chosen ones are kept.
        if (found === null) {
          const calendars = await discoverCalDav(chosen, server.trim(), username.trim(), password)
          setFound(calendars)
          setPicked(calendars.filter((calendar) => calendar.writable !== false).map((calendar) => calendar.url))
          setBusy(false)
          return
        }
        await addCalDav(
          chosen,
          username.trim(),
          password,
          found.filter((calendar) => picked.includes(calendar.url)),
        )
        onClose()
        return
      }
      if (kind === 'account') await createCalendar(chosen, name.trim())
      else if (kind === 'local') await createLocalCalendar(chosen, name.trim())
      else await subscribeCalendar(chosen, name.trim(), url.trim())
      onClose()
    } catch (err) {
      // Kept open with the message: the URL is the likeliest thing to be
      // wrong, and closing would lose it.
      setError(String(err))
      setBusy(false)
    }
  }

  const hint =
    kind === 'account'
      ? t('calendar.kindAccountHint', {
          defaultValue: 'Created on the account’s server, and available wherever you read that account.',
        })
      : kind === 'local'
        ? t('calendar.kindLocalHint', {
            defaultValue:
              'Kept only in this copy of Oreneta. Nothing else has a copy, so it is lost if this profile is.',
          })
        : kind === 'caldav'
          ? t('calendar.kindCalDavHint', {
              defaultValue:
                'Calendars on a CalDAV server (Fastmail, iCloud, Nextcloud, Radicale…), read and written in place. The password is kept in the system keychain.',
            })
          : t('calendar.kindSubscribedHint', {
              defaultValue: 'Follows a published calendar file. Read-only — it belongs to whoever publishes it.',
            })

  return (
    <Dialog
      title={t('calendar.addCalendar', { defaultValue: 'Add calendar' })}
      icon={CalendarDays}
      layer="raised"
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('calendar.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button onClick={() => void submit()} disabled={invalid || busy}>
            {kind === 'caldav' && found === null
              ? t('calendar.findCalendars', { defaultValue: 'Find calendars' })
              : t('calendar.add', { defaultValue: 'Add' })}
          </Button>
        </>
      }
    >
      <div
        className="grid grid-cols-2 gap-1 rounded-panel border border-border/80 bg-raised p-1 min-[520px]:grid-cols-4"
        role="radiogroup"
      >
        <KindTab
          active={kind === 'account'}
          icon={<Cloud size={16} strokeWidth={1.75} />}
          label={t('calendar.kindAccount', { defaultValue: 'In an account' })}
          onClick={() => setKind('account')}
        />
        <KindTab
          active={kind === 'local'}
          icon={<HardDrive size={16} strokeWidth={1.75} />}
          label={t('calendar.kindLocal', { defaultValue: 'On this computer' })}
          onClick={() => setKind('local')}
        />
        <KindTab
          active={kind === 'subscribed'}
          icon={<Link2 size={16} strokeWidth={1.75} />}
          label={t('calendar.kindSubscribed', { defaultValue: 'From a link' })}
          onClick={() => setKind('subscribed')}
        />
        <KindTab
          active={kind === 'caldav'}
          icon={<Server size={16} strokeWidth={1.75} />}
          label={t('calendar.kindCalDav', { defaultValue: 'CalDAV server' })}
          onClick={() => setKind('caldav')}
        />
      </div>

      <p className="px-0.5 text-caption text-secondary">{hint}</p>

      {kind === 'account' && capable.length === 0 ? (
        <Notice tone="warning">
          {t('calendar.noServerAccounts', {
            defaultValue:
              'None of these accounts keeps calendars on a server. Exchange accounts do — their calendars arrive with the account.',
          })}
        </Notice>
      ) : (
        <div className="flex flex-col gap-3">
          {kind === 'caldav' ? (
            <>
              <Labelled label={t('calendar.server', { defaultValue: 'Server or address' })}>
                <TextInput
                  value={server}
                  onChange={(e) => {
                    setServer(e.target.value)
                    setFound(null)
                  }}
                  placeholder="caldav.example.com"
                  autoFocus
                  fieldSize="md"
                  surface="raised"
                  className="w-full"
                />
              </Labelled>
              <Labelled label={t('calendar.username', { defaultValue: 'User name' })}>
                <TextInput
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value)
                    setFound(null)
                  }}
                  autoComplete="username"
                  fieldSize="md"
                  surface="raised"
                  className="w-full"
                />
              </Labelled>
              <Labelled label={t('calendar.password', { defaultValue: 'Password' })}>
                <TextInput
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    setFound(null)
                  }}
                  autoComplete="current-password"
                  fieldSize="md"
                  surface="raised"
                  className="w-full"
                />
              </Labelled>
              {found !== null && (
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1 pl-0.5 text-caption font-semibold text-secondary">
                    {t('calendar.foundCalendars', { defaultValue: 'Calendars on this server' })}
                  </legend>
                  {found.map((calendar) => (
                    <label key={calendar.url} className="flex items-center gap-2 text-caption text-primary">
                      <input
                        type="checkbox"
                        checked={picked.includes(calendar.url)}
                        onChange={(e) =>
                          setPicked((list) =>
                            e.target.checked ? [...list, calendar.url] : list.filter((url) => url !== calendar.url),
                          )
                        }
                      />
                      <span>{calendar.name}</span>
                      {calendar.writable === false && (
                        <span className="text-2xs text-secondary">
                          {t('calendar.readOnly', { defaultValue: 'read-only' })}
                        </span>
                      )}
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          ) : (
            <Labelled label={t('calendar.name', { defaultValue: 'Name' })}>
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                fieldSize="md"
                surface="raised"
                className="w-full"
              />
            </Labelled>
          )}

          {kind === 'subscribed' && (
            <Labelled label={t('calendar.url', { defaultValue: 'Address' })}>
              <TextInput
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.org/calendar.ics"
                fieldSize="md"
                surface="raised"
                className="w-full"
              />
            </Labelled>
          )}

          {pool.length > 1 && (
            <Labelled
              label={
                kind === 'account'
                  ? t('calendar.inAccount', { defaultValue: 'Account' })
                  : t('calendar.listedUnder', { defaultValue: 'Listed under' })
              }
            >
              <SelectInput
                value={chosen}
                onChange={(e) => setAccountId(e.target.value)}
                fieldSize="md"
                surface="raised"
              >
                {pool.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.email}
                  </option>
                ))}
              </SelectInput>
            </Labelled>
          )}

          {error && (
            <p role="alert" className="text-caption text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}

function KindTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`flex min-w-0 cursor-pointer flex-col items-center gap-1 rounded-control px-2 py-2.5 text-center transition-all ${
        active
          ? 'bg-chats text-primary shadow-sm ring-1 ring-border/80'
          : 'text-secondary hover:bg-chats/60 hover:text-primary'
      }`}
    >
      <span className={active ? 'text-accent' : ''}>{icon}</span>
      <span className="text-2xs font-semibold leading-tight">{label}</span>
    </button>
  )
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex w-full flex-col gap-1.5">
      <span className="pl-0.5 text-caption font-semibold text-secondary">{label}</span>
      {children}
    </label>
  )
}
