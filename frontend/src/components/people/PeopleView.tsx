import { useEffect, useRef } from 'react'
import {
  ArrowLeft,
  BookUser,
  Building2,
  Copy,
  Download,
  Mail,
  Pencil,
  Phone,
  Plus,
  SquarePen,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { clsx } from '../../lib/utils'
import { accounts$, isSendableAccount } from '../../states/accounts'
import { openComposeTab } from '../../states/compose'
import {
  deletePerson,
  draftOf,
  emptyDraft,
  exportVcf,
  loadPeople,
  people$,
  collapseLinked,
  deleteGroup,
  groupRecipients,
  groupsFor,
  loadDuplicates,
  loadGroups,
  setMembership,
  sourceLabel,
  startVcfImport,
  unlinkPerson,
} from '../../states/people'
import { confirmAction, showToast, ui$ } from '../../states/ui'
import { useContactNames } from '../../states/contactNames'
import type { ContactGroup, Person } from '../../types'
import { Avatar } from '../avatar/Avatar'
import { EmptyState } from '../empty-state/EmptyState'
import { LoadingState } from '../empty-state/StateViews'
import { IconButton } from '../button/IconButton'
import { CompactNavigation } from '../sidenav/CompactNavigation'
import { FOLDER_PANE_MIN_WINDOW, FolderPane } from '../shell/FolderPane'
import { useWideWindow } from '../resizer/useElementWidth'
import { useFolderPaneFocus } from '../shell/folderPaneFocus'
import { Button } from '../button/Button'
import { PersonEditor } from './PersonEditor'
import { VcfImportDialog } from './VcfImportDialog'
import { DuplicatesDialog } from './DuplicatesDialog'
import { GroupDialog } from './GroupDialog'
import { PeopleGroups } from './PeopleGroups'

/**
 * The address book, as a place rather than as a dropdown.
 *
 * Two panes: everyone on the left, one person on the right. What the right
 * pane can do is exactly what the book knows — write to an address, dial
 * nothing but show the number, copy either — and it says where each person
 * came from, because a person from a CardDAV server and one from Google are
 * two rows on purpose and the reader should be able to tell which is which.
 *
 * Only the local book is written to from here (ADR-0012): its people have an
 * edit and a delete button. A synced book's people have neither — there is no
 * edit button that turns out not to save. Editing those lives where the book
 * does until writing back to it exists.
 *
 * Its groups are the "folders" region. From 1025 px they are the common folder
 * pane, beside the whole module, at the width every module shares (ADR-0068
 * §4); below that the pane is not drawn and they keep their place under the
 * list's header, as a filter, as before.
 */
export function PeopleView() {
  const { t } = useTranslation()
  const everyone = useValue(people$.people)
  const groups = useValue(people$.groups)
  const groupFilter = useValue(people$.groupFilter)
  const names = useContactNames()
  const shownGroup = groups.find((group) => group.id === groupFilter) ?? null
  // People linked as one show once (ADR-0012), in the reader's name order,
  // and only the chosen group's when one is chosen (ADR-0052).
  const memberIds = shownGroup ? new Set(shownGroup.members.map((member) => member.id)) : null
  const people = names.sorted(collapseLinked(everyone).filter((person) => !memberIds || memberIds.has(person.id)))
  const duplicates = useValue(people$.duplicates)
  const loaded = useValue(people$.loaded)
  const loading = useValue(people$.loading)
  const query = useValue(people$.query)
  const selectedId = useValue(people$.selectedId)
  const accounts = useValue(accounts$)
  const lastSelection = useRef<HTMLButtonElement | null>(null)
  const detailRef = useRef<HTMLElement | null>(null)
  const focusNavigation = useRef(false)
  const inPane = useWideWindow(FOLDER_PANE_MIN_WINDOW)
  useFolderPaneFocus(inPane)

  useEffect(() => {
    if (!loaded) void loadPeople()
  }, [loaded])
  useEffect(() => {
    void loadDuplicates()
    void loadGroups()
  }, [])

  // Searching re-asks the core rather than filtering what is loaded: the list
  // is capped, and a person past the cap would otherwise be unfindable.
  useEffect(() => {
    const timer = setTimeout(() => void loadPeople(query), 150)
    return () => clearTimeout(timer)
  }, [query])

  const selected = everyone.find((person) => person.id === selectedId) ?? null
  const copies = selected?.link ? everyone.filter((person) => person.link === selected.link) : []
  useEffect(() => {
    if (!focusNavigation.current || !lastSelection.current) return
    focusNavigation.current = false
    if (selected) detailRef.current?.focus()
    else lastSelection.current.focus()
  }, [selected?.id])

  const writeTo = (person: Person, addr: string) => {
    // A book that belongs to an account writes from that account; one that
    // belongs to nobody writes from whichever can send.
    const owner = accounts.find((account) => account.id === person.account && isSendableAccount(account))
    const from = owner ?? accounts.find(isSendableAccount)
    if (!from) return
    ui$.module.set('mail')
    openComposeTab({ accountId: from.id, to: person.name ? `${person.name} <${addr}>` : addr })
  }

  // Everyone in the shown group who has an address, from whichever account
  // can send.
  const writeToGroup = (group: ContactGroup) => {
    const from = accounts.find(isSendableAccount)
    const recipients = groupRecipients(group)
    if (!from || recipients.length === 0) return
    ui$.module.set('mail')
    openComposeTab({
      accountId: from.id,
      to: recipients
        .map((member) => (member.name ? `"${member.name.replace(/"/g, '')}" <${member.addr}>` : member.addr))
        .join(', '),
    })
  }

  const removeGroup = async (group: ContactGroup) => {
    const confirmed = await confirmAction({
      title: t('people.deleteGroupTitle', { defaultValue: 'Delete group?' }),
      message:
        // A server book's group goes on the server: CardDAV, and an
        // Exchange folder's distribution lists (ADR-0058, ADR-0066).
        group.source === 'carddav' || group.source === 'exchange'
          ? t('people.deleteGroupTextServer', {
              name: group.name,
              defaultValue:
                'The group {name} will be deleted from the address book on its server. The people in it stay.',
            })
          : t('people.deleteGroupText', {
              name: group.name,
              defaultValue: 'The group {name} will be deleted. The people in it stay.',
            }),
      confirmLabel: t('buttons.delete'),
      tone: 'danger',
    })
    if (confirmed) await deleteGroup(group)
  }

  const removePerson = async (person: Person) => {
    const confirmed = await confirmAction({
      title: t('people.deleteTitle', { defaultValue: 'Delete contact?' }),
      message:
        person.source === 'carddav' || person.source === 'exchange'
          ? t('people.deleteTextServer', {
              name: person.name || person.emails[0]?.addr || '',
              defaultValue: '{name} will be deleted from the address book on its server, for every app that reads it.',
            })
          : t('people.deleteText', {
              name: person.name || person.emails[0]?.addr || '',
              defaultValue: '{name} will be deleted from the address book on this computer.',
            }),
      confirmLabel: t('buttons.delete'),
      tone: 'danger',
    })
    if (confirmed) await deletePerson(person)
  }

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => showToast(t('people.copied')))
  }

  return (
    <>
      {inPane && (
        <FolderPane title={t('people.contactGroups')}>
          <PeopleGroups onWrite={writeToGroup} onDelete={(group) => void removeGroup(group)} />
        </FolderPane>
      )}
      <div
        data-region="content"
        // Beside the pane the module asks for its list (288 px) and the
        // reader's minimum for the person (360 px, ADR-0068 §7) as its basis:
        // the pane, whose shrink factor dwarfs this one's, gives way first.
        className={clsx('flex min-h-0 min-w-0 bg-app', inPane ? 'flex-[1_1_648px]' : 'flex-1')}
      >
        <section
          // The pane is the "folders" region from 1025 px; this is the list.
          data-region={inPane ? undefined : 'folders'}
          className={clsx(
            'min-w-0 w-full shrink-0 flex-col border-e border-border bg-chats min-[769px]:flex',
            // 18 rem, as before; beside the folder pane it is in px, like the
            // pane, so at the app's 200 % the person keeps their room
            // (ADR-0068 §7).
            inPane ? 'min-[769px]:w-[288px]' : 'min-[769px]:w-72',
            selected ? 'hidden' : 'flex',
          )}
        >
          <header className="flex shrink-0 flex-col gap-3 border-b border-border bg-header px-4 py-3">
            <CompactNavigation />
            <div className={clsx('flex items-center justify-between gap-2', inPane && 'flex-wrap')}>
              <h1 className="flex items-center gap-2 text-heading-sm font-bold text-primary">
                <BookUser size={20} strokeWidth={1.75} aria-hidden="true" />
                {t('people.title')}
              </h1>
              <div className="flex items-center gap-1">
                <IconButton
                  icon={Upload}
                  iconSize={14}
                  size="sm"
                  label={t('people.import', { defaultValue: 'Import contacts' })}
                  onClick={() => void startVcfImport()}
                />
                <IconButton
                  icon={Download}
                  iconSize={14}
                  size="sm"
                  label={t('people.export', { defaultValue: 'Export contacts' })}
                  // What the list shows: everybody, or the people a search found.
                  onClick={() => void exportVcf(query ? people.map((person) => person.id) : undefined)}
                />
                <Button variant="secondary" size="sm" onClick={() => people$.editing.set({ draft: emptyDraft() })}>
                  <UserPlus size={14} strokeWidth={1.75} />
                  {t('people.newContact', { defaultValue: 'New contact' })}
                </Button>
              </div>
            </div>
            {!inPane && (
              <div
                // Below 1025 px the group filter stands in for the pane: focus goes back here (#341).
                data-focus-return
                className="flex min-w-0 items-center gap-1"
              >
                <Users size={14} className="shrink-0 text-secondary" strokeWidth={1.75} aria-hidden="true" />
                {groups.length > 0 ? (
                  <select
                    value={shownGroup ? shownGroup.id : ''}
                    data-focus-key="group-filter"
                    onChange={(event) => people$.groupFilter.set(event.target.value)}
                    aria-label={t('people.groupFilter', { defaultValue: 'Show group' })}
                    className="min-w-0 flex-1 rounded-control-sm border border-border bg-chats px-2 py-1 text-caption text-primary outline-none focus:border-accent-fg"
                  >
                    <option value="">{t('people.allContacts', { defaultValue: 'All contacts' })}</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {t('people.groupOption', {
                          name: group.name,
                          count: group.members.length,
                          defaultValue: '{name} ({count})',
                        })}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-caption text-secondary">
                    {t('people.groupsNone', { defaultValue: 'No groups yet' })}
                  </span>
                )}
                <IconButton
                  icon={Plus}
                  iconSize={14}
                  size="sm"
                  data-focus-key="group-new"
                  label={t('people.newGroup', { defaultValue: 'New group' })}
                  onClick={() => people$.groupEditing.set({ name: '', book: '', members: [] })}
                />
                {shownGroup && (
                  <IconButton
                    icon={Mail}
                    iconSize={14}
                    size="sm"
                    label={t('people.writeToGroup', {
                      name: shownGroup.name,
                      defaultValue: 'Write to everyone in {name}',
                    })}
                    data-focus-key="group-write"
                    disabled={groupRecipients(shownGroup).length === 0}
                    onClick={() => writeToGroup(shownGroup)}
                  />
                )}
                {shownGroup?.editable && (
                  <>
                    <IconButton
                      icon={Pencil}
                      iconSize={14}
                      size="sm"
                      data-focus-key="group-rename"
                      label={t('people.renameGroup', { defaultValue: 'Rename group' })}
                      onClick={() =>
                        people$.groupEditing.set({
                          id: shownGroup.id,
                          version: shownGroup.version,
                          name: shownGroup.name,
                          book: shownGroup.book,
                          members: shownGroup.members.map((member) => member.id),
                        })
                      }
                    />
                    <IconButton
                      icon={Trash2}
                      iconSize={14}
                      size="sm"
                      data-focus-key="group-delete"
                      label={t('people.deleteGroup', { defaultValue: 'Delete group' })}
                      onClick={() => void removeGroup(shownGroup)}
                    />
                  </>
                )}
              </div>
            )}
            {duplicates.length > 0 && (
              <button
                type="button"
                onClick={() => people$.duplicatesOpen.set(true)}
                className="self-start rounded-control-sm px-2 py-1 text-caption font-semibold text-accent-fg hover:bg-hover cursor-pointer"
              >
                {t('people.duplicatesCount', {
                  count: duplicates.length,
                  defaultValue: '{count, plural, one {# possible duplicate} other {# possible duplicates}}',
                })}
              </button>
            )}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!loaded && loading ? (
              <LoadingState title={t('people.loading')} />
            ) : people.length === 0 ? (
              <EmptyState
                title={
                  query
                    ? t('people.noMatch')
                    : shownGroup
                      ? t('people.groupEmpty', { defaultValue: 'Nobody in this group' })
                      : t('people.emptyTitle')
                }
                text={
                  query
                    ? t('people.tryAnother')
                    : shownGroup
                      ? t('people.groupEmptyText', {
                          defaultValue: 'Open a contact and add them to the group from their card.',
                        })
                      : t('people.emptyText')
                }
              />
            ) : (
              <ul role="listbox" aria-label={t('people.title')}>
                {people.map((person) => {
                  const active = person.id === selectedId
                  return (
                    // The option is the listbox's child as far as assistive
                    // technology is concerned; the list item is only layout.
                    <li key={person.id} role="none">
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={(event) => {
                          lastSelection.current = event.currentTarget
                          focusNavigation.current = true
                          people$.selectedId.set(person.id)
                          if (selected?.id === person.id) {
                            focusNavigation.current = false
                            detailRef.current?.focus()
                          }
                        }}
                        className={clsx(
                          'flex w-full items-center gap-3 border-b border-border/50 px-3 py-2 text-start transition-colors cursor-pointer',
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
                          <span dir="auto" className="block truncate text-ui font-semibold text-primary">
                            {names.format(person)}
                          </span>
                          {/* On the selected row's tinted background the secondary
                            colour falls just under 4.5:1, so it uses the primary. */}
                          <span
                            className={clsx('block truncate text-caption', active ? 'text-primary' : 'text-secondary')}
                          >
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

        <section
          ref={detailRef}
          tabIndex={-1}
          aria-label={selected ? names.format(selected) : undefined}
          className={clsx(
            'min-h-0 min-w-0 flex-1 flex-col overflow-y-auto min-[769px]:flex',
            selected ? 'flex' : 'hidden',
          )}
        >
          {selected ? (
            <>
              <div className="shrink-0 border-b border-border bg-header px-4 py-3 min-[769px]:hidden">
                <button
                  type="button"
                  onClick={() => {
                    focusNavigation.current = true
                    people$.selectedId.set('')
                  }}
                  className="inline-flex min-h-8 items-center gap-2 rounded-control-sm px-2 text-ui font-semibold text-secondary hover:bg-hover cursor-pointer"
                >
                  <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
                  {t('buttons.back')}
                </button>
              </div>
              <PersonCard
                person={selected}
                displayName={names.format(selected)}
                groups={groups}
                onWrite={(addr) => writeTo(selected, addr)}
                onCopy={copy}
                onEdit={() =>
                  people$.editing.set({
                    id: selected.id,
                    version: selected.version,
                    serverBook:
                      selected.source === 'carddav' || selected.source === 'exchange' ? selected.book : undefined,
                    draft: draftOf(selected),
                  })
                }
                onDelete={() => void removePerson(selected)}
              />
              {copies.length > 1 && (
                <section className="mx-auto w-full max-w-2xl px-4 pb-6 min-[769px]:px-6">
                  <h2 className="mb-2 text-caption font-bold uppercase tracking-wide text-secondary">
                    {t('people.linkedCopies', { defaultValue: 'Linked copies' })}
                  </h2>
                  <ul className="overflow-hidden rounded-control border border-border">
                    {copies.map((copy) => (
                      <li
                        key={copy.id}
                        className="flex flex-wrap items-center gap-2 border-b border-border bg-chats px-3 py-2 last:border-b-0"
                      >
                        <button
                          type="button"
                          aria-current={copy.id === selected.id}
                          onClick={() => people$.selectedId.set(copy.id)}
                          className="min-w-0 flex-1 text-start text-ui text-primary cursor-pointer"
                        >
                          {names.format(copy)}{' '}
                          <span className="text-caption text-secondary">
                            · {t(`people.source.${sourceLabel(copy.source)}`)}
                          </span>
                        </button>
                        <Button variant="ghost" size="sm" onClick={() => void unlinkPerson(copy.id)}>
                          {t('people.unlink', { defaultValue: 'Unlink' })}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState title={t('people.pickSomeone')} text={t('people.pickSomeoneText')} />
            </div>
          )}
        </section>
        <PersonEditor />
        <VcfImportDialog />
        <DuplicatesDialog />
        <GroupDialog />
      </div>
    </>
  )
}

function PersonCard({
  person,
  displayName,
  groups,
  onWrite,
  onCopy,
  onEdit,
  onDelete,
}: {
  person: Person
  displayName: string
  groups: ContactGroup[]
  onWrite: (addr: string) => void
  onCopy: (text: string) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const source = sourceLabel(person.source)
  const memberOf = groups.filter((group) => group.members.some((member) => member.id === person.id))
  const joinable = groupsFor(person, groups).filter((group) => !memberOf.includes(group))

  return (
    <div className="mx-auto w-full max-w-2xl p-4 min-[769px]:p-6">
      <header className="flex flex-wrap items-center gap-4 rounded-panel border border-border bg-chats p-4">
        <Avatar
          name={person.name}
          email={person.emails[0]?.addr}
          src={person.photo ? `/media/${person.photo}` : undefined}
          size={72}
        />
        <div className="min-w-0 flex-1 basis-40">
          <h2 dir="auto" className="wrap-anywhere text-heading font-bold text-primary">
            {displayName}
          </h2>
          {person.organisation && (
            <p className="mt-1 flex items-start gap-1.5 wrap-anywhere text-ui text-secondary">
              <Building2 size={14} strokeWidth={1.75} /> {person.organisation}
            </p>
          )}
          {/* Where they came from, as a fact rather than an icon. */}
          <p className="mt-1 text-caption text-secondary">{t(`people.source.${source}`)}</p>
        </div>
        {person.editable && (
          <div className="flex gap-1">
            <IconButton
              icon={Pencil}
              iconSize={14}
              size="sm"
              label={t('people.edit', { defaultValue: 'Edit' })}
              onClick={onEdit}
            />
            <IconButton icon={Trash2} iconSize={14} size="sm" label={t('buttons.delete')} onClick={onDelete} />
          </div>
        )}
      </header>

      {(memberOf.length > 0 || joinable.length > 0) && (
        <section className="mt-6" aria-label={t('people.groups', { defaultValue: 'Groups' })}>
          <h2 className="mb-2 text-caption font-bold uppercase tracking-wide text-secondary">
            {t('people.groups', { defaultValue: 'Groups' })}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {memberOf.map((group) => (
              <span
                key={group.id}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-chats py-0.5 ps-2.5 pe-1 text-caption text-primary"
              >
                <span className="wrap-anywhere">{group.name}</span>
                {group.editable && (
                  <IconButton
                    icon={X}
                    iconSize={12}
                    size="sm"
                    label={t('people.leaveGroup', { name: group.name, defaultValue: 'Remove from {name}' })}
                    onClick={() => void setMembership(group, person.id, false)}
                  />
                )}
              </span>
            ))}
            {joinable.length > 0 && (
              <select
                value=""
                aria-label={t('people.addToGroup', { defaultValue: 'Add to group' })}
                onChange={(event) => {
                  const group = joinable.find((candidate) => candidate.id === event.target.value)
                  if (group) void setMembership(group, person.id, true)
                }}
                className="rounded-control-sm border border-border bg-chats px-2 py-1 text-caption text-primary outline-none focus:border-accent-fg"
              >
                <option value="">{t('people.addToGroup', { defaultValue: 'Add to group' })}</option>
                {joinable.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </section>
      )}

      {person.emails.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-caption font-bold uppercase tracking-wide text-secondary">{t('people.emails')}</h2>
          <ul className="overflow-hidden rounded-control border border-border">
            {person.emails.map((email) => (
              <li
                key={email.addr}
                className="flex flex-wrap items-center gap-2 border-b border-border bg-chats px-3 py-3 last:border-b-0"
              >
                <Mail size={14} className="shrink-0 text-secondary" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 basis-40 wrap-anywhere text-ui text-primary">{email.addr}</span>
                {email.label && (
                  <span className="max-w-full wrap-anywhere text-caption text-secondary">{email.label}</span>
                )}
                <IconButton
                  icon={Copy}
                  iconSize={14}
                  size="sm"
                  label={t('people.copy')}
                  onClick={() => onCopy(email.addr)}
                />
                <IconButton
                  icon={SquarePen}
                  iconSize={14}
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
                className="flex flex-wrap items-center gap-2 border-b border-border bg-chats px-3 py-3 last:border-b-0"
              >
                <Phone size={14} className="shrink-0 text-secondary" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 basis-40 wrap-anywhere text-ui text-primary tabular-nums">
                  {phone.number}
                </span>
                {phone.label && (
                  <span className="max-w-full wrap-anywhere text-caption text-secondary">{phone.label}</span>
                )}
                <IconButton
                  icon={Copy}
                  iconSize={14}
                  size="sm"
                  label={t('people.copy')}
                  onClick={() => onCopy(phone.number)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {person.note && (
        <section className="mt-6">
          <h2 className="mb-2 text-caption font-bold uppercase tracking-wide text-secondary">{t('people.note')}</h2>
          <p
            dir="auto"
            className="bidi-plaintext whitespace-pre-wrap wrap-anywhere text-ui leading-relaxed text-primary"
          >
            {person.note}
          </p>
        </section>
      )}
    </div>
  )
}
