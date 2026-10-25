import { useEffect, useId, useMemo, useRef } from 'react'
import { useValue } from '@legendapp/state/react'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { openCalendarOn } from '../../states/calendar'
import { useContactNames } from '../../states/contactNames'
import { openMailAccount } from '../../states/kanban'
import { people$ } from '../../states/people'
import {
  chooseForContact,
  person$,
  pickParticipant,
  resolvePersonPanel,
  type PanelParticipant,
} from '../../states/person'
import { closeSidebarOverlay } from '../../states/sidebar'
import { ui$ } from '../../states/ui'
import type { Account } from '../../types'
import { Avatar } from '../avatar/Avatar'
import { IconButton } from '../button/IconButton'
import { SelectInput } from '../field/Field'
import { useActiveConversation, useConversationMessages, useConversationOpen } from './activeConversation'
import { buildParticipants } from './conversationMedia'
import { PersonHistory } from './PersonHistory'

const accountName = (account: Account | undefined) => account?.display_name || account?.email || ''

/**
 * The Persona panel of the app's sidebar (ADR-0069 §4): the history of the
 * person in context (#86), in every module. In mail, the open conversation's
 * one other person, or the one picked from its list; in Persones, the selected
 * contact, in the account of its book or, when the book is nobody's, the one
 * the reader chooses; elsewhere, or with nothing selected, what to select.
 * Always one account, never chosen by itself, and the person is never stored.
 */
export function PersonPanel() {
  const { t } = useTranslation()
  const appModule = useValue(ui$.module)
  const conversationOpen = useConversationOpen()
  const { accounts, activeThread, isRSS } = useActiveConversation()
  const { displayMessages, loading, ours } = useConversationMessages(activeThread)
  const participant = useValue(person$.participant)
  const choice = useValue(person$.contact)
  const selectedId = useValue(people$.selectedId)
  const everyone = useValue(people$.people)
  const names = useContactNames()

  // The conversation's people from its own messages only, never from the
  // previous conversation's, which the messages still are while it loads.
  // With none of its messages there and nothing loading (a failed read, or
  // messages whose bodies are still to come, which offline may be never),
  // they are the people on the row the list shows, which is this
  // conversation's.
  const participants = useMemo(
    () => (activeThread && !loading ? buildParticipants(ours ? displayMessages : [activeThread], accounts, isRSS) : []),
    [activeThread, loading, ours, displayMessages, accounts, isRSS],
  )
  const view = resolvePersonPanel({
    module: appModule,
    conversation:
      conversationOpen && activeThread
        ? {
            thread: activeThread.thread_id,
            account: activeThread.account_id,
            loading,
            participants,
          }
        : null,
    participant,
    contact: appModule === 'people' ? (everyone.find((person) => person.id === selectedId) ?? null) : null,
    choice,
    accounts,
  })

  // Where the focus goes once the panel's content changes under it: picking
  // a person shows their history, and going back shows the list again.
  const focusNext = useRef<{ heading: true } | { address: string } | null>(null)
  // Asked for the drawing that follows, and forgotten after it, so that a
  // later change of the panel never takes the focus.
  const askFocus = (target: { heading: true } | { address: string }) => {
    focusNext.current = target
    setTimeout(() => {
      if (focusNext.current === target) focusNext.current = null
    }, 0)
  }
  const panelRef = useRef<HTMLDivElement | null>(null)
  const viewKey =
    view.kind === 'history' ? `history:${view.address}` : view.kind === 'participants' ? 'participants' : view.kind
  useEffect(() => {
    const target = focusNext.current
    focusNext.current = null
    if (!target || !panelRef.current) return
    const element =
      'heading' in target
        ? panelRef.current.querySelector<HTMLElement>('[data-person-heading]')
        : panelRef.current.querySelector<HTMLElement>(`[data-participant="${CSS.escape(target.address)}"]`)
    element?.focus({ preventScroll: true })
  }, [viewKey])

  // A history's items open where they came from, as the agenda's do (an
  // overlay goes first): a conversation in mail, in the account of the
  // history, with the person still in context, and below 769 px the
  // conversation in place of the list, as Tasks and Attachments open one; an
  // event's day in Calendar.
  const openConversation = (account: string, address: string, name: string) => (threadId: string, folder: string) => {
    closeSidebarOverlay()
    if (ui$.module.peek() !== 'mail') ui$.module.set('mail')
    openMailAccount(account, folder, false)
    ui$.selectedThread.set(threadId)
    ui$.mobilePane.set('conversation')
    pickParticipant({ thread: threadId, account, address, name })
  }
  const openEvent = (start: number) => {
    closeSidebarOverlay()
    openCalendarOn(new Date(start * 1000))
  }

  const hint = (text: string) => (
    <p className="flex flex-1 items-center justify-center px-6 py-8 text-center text-caption text-secondary">{text}</p>
  )

  let body
  switch (view.kind) {
    case 'empty':
      body = hint(
        view.where === 'mail'
          ? t('person.emptyMail')
          : view.where === 'people'
            ? t('person.emptyPeople')
            : t('person.emptyElsewhere'),
      )
      break
    case 'loading':
      body = (
        <div className="flex justify-center p-6">
          <Loader2
            size={18}
            className="animate-spin text-secondary"
            strokeWidth={1.75}
            aria-label={t('common.loading')}
          />
        </div>
      )
      break
    case 'nobody':
      body = hint(t('person.nobodyElse'))
      break
    case 'participants':
      body = (
        <ParticipantChoice
          participants={view.participants}
          onPick={(person) => {
            askFocus({ heading: true })
            pickParticipant({ thread: view.thread, account: view.account, address: person.email, name: person.name })
          }}
        />
      )
      break
    case 'history': {
      const shown = view
      body = (
        <>
          <PersonHeader
            name={view.name}
            address={view.address}
            account={accountName(accounts.find((account) => account.id === view.account))}
            onBack={
              view.back
                ? () => {
                    askFocus({ address: shown.address })
                    pickParticipant(null)
                  }
                : undefined
            }
          />
          <PersonHistory
            accountId={view.account}
            address={view.address}
            onOpenConversation={openConversation(view.account, view.address, view.name)}
            onOpenEvent={openEvent}
          />
        </>
      )
      break
    }
    case 'noAddress':
      body = (
        <>
          <PersonHeader name={names.format(view.contact)} />
          {hint(t('person.noAddress'))}
        </>
      )
      break
    case 'contact': {
      const { contact, addresses, address, accounts: choices, account } = view
      const name = names.format(contact)
      body = (
        <>
          <PersonHeader
            name={name}
            address={addresses.length === 1 ? address : undefined}
            account={choices ? undefined : accountName(accounts.find((candidate) => candidate.id === account))}
          />
          {(addresses.length > 1 || choices) && (
            <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
              {addresses.length > 1 && (
                <ChoiceField
                  label={t('person.address')}
                  placeholder={t('person.chooseAddress')}
                  value={address}
                  options={addresses.map((candidate) => ({ value: candidate, label: candidate }))}
                  onChange={(value) => chooseForContact(contact.id, { address: value || undefined })}
                />
              )}
              {choices && (
                <>
                  <p className="text-caption text-secondary">{t('person.noBookAccount')}</p>
                  <ChoiceField
                    label={t('person.account')}
                    placeholder={t('person.chooseAccount')}
                    value={account}
                    options={choices.map((candidate) => ({
                      value: candidate.id,
                      label: candidate.display_name
                        ? `${candidate.display_name} (${candidate.email})`
                        : candidate.email,
                    }))}
                    onChange={(value) => chooseForContact(contact.id, { account: value || undefined })}
                  />
                </>
              )}
              {addresses.length > 1 && !address && (
                <p className="text-caption text-secondary">{t('person.severalAddresses')}</p>
              )}
            </div>
          )}
          {address && account && (
            <PersonHistory
              accountId={account}
              address={address}
              onOpenConversation={openConversation(account, address, name)}
              onOpenEvent={openEvent}
            />
          )}
        </>
      )
      break
    }
  }

  return (
    <div ref={panelRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {body}
    </div>
  )
}

/** Who the history is about, its address and the account it is read from. */
function PersonHeader({
  name,
  address,
  account,
  onBack,
}: {
  name: string
  address?: string
  account?: string
  onBack?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
      <span aria-hidden="true" className="shrink-0">
        <Avatar name={name} email={address} size={36} />
      </span>
      <div className="min-w-0 flex-1">
        <h3
          data-person-heading
          tabIndex={-1}
          dir="auto"
          title={name}
          className="truncate text-sm font-bold text-primary"
        >
          {t('person.title', { name })}
        </h3>
        {address && (
          <p dir="auto" className="truncate text-caption text-secondary selectable-text" title={address}>
            {address}
          </p>
        )}
        {account && <p className="truncate text-2xs text-secondary">{t('person.inAccount', { account })}</p>}
      </div>
      {onBack && (
        <IconButton
          icon={ChevronLeft}
          iconSize={20}
          label={t('person.pickAnother')}
          className="shrink-0 rtl:[&>svg]:-scale-x-100"
          onClick={onBack}
        />
      )}
    </div>
  )
}

/** The conversation's people who are not the reader, to pick whose history to see. */
function ParticipantChoice({
  participants,
  onPick,
}: {
  participants: PanelParticipant[]
  onPick: (person: PanelParticipant) => void
}) {
  const { t } = useTranslation()
  const heading = useId()
  return (
    <div className="p-3">
      <h3 id={heading} className="mb-2 px-2 text-caption font-bold text-secondary">
        {t('person.pickParticipant')}
      </h3>
      <ul aria-labelledby={heading} className="flex flex-col gap-0.5">
        {participants.map((person) => (
          <li key={person.email}>
            <button
              type="button"
              data-participant={person.email}
              onClick={() => onPick(person)}
              className="flex w-full cursor-pointer items-center gap-3 rounded-control p-2 text-start hover:bg-hover"
            >
              <span aria-hidden="true" className="shrink-0">
                <Avatar name={person.name} email={person.email} size={32} />
              </span>
              <span className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-xs font-semibold text-primary">
                  {person.name}
                </span>
                <span dir="auto" className="block truncate text-caption text-secondary">
                  {person.email}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A choice the panel asks for, with nothing chosen until the reader chooses. */
function ChoiceField({
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  label: string
  placeholder: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-caption font-semibold text-primary">
        {label}
      </label>
      <SelectInput id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectInput>
    </div>
  )
}
