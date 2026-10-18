import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent } from 'react'
import { useTranslation } from '../../lib/i18n'
import { formatContact, searchDirectory, suggestContacts } from '../../lib/contacts'
import { useValue } from '@legendapp/state/react'
import { accounts$ } from '../../states/accounts'
import { commitPending, editAt, fieldParts, removeAt, setPending } from '../../lib/recipientField'
import type { Contact, ContactGroup } from '../../types'
import { Chip } from '../chip/Chip'
import { groupRecipients, loadGroups, people$ } from '../../states/people'
import { useContactNames } from '../../states/contactNames'

/** Groups whose name holds what was typed, with somebody to write to. */
export function matchingGroups(groups: ContactGroup[], query: string): ContactGroup[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return groups
    .filter((group) => group.name.toLowerCase().includes(needle) && groupRecipients(group).length > 0)
    .slice(0, 3)
}

type RecipientInputProps = {
  value: string
  onChange: (value: string) => void
  accountId: string
  placeholder?: string
  autoFocus?: boolean
}

// At least 8rem to type in, but never wider than the field it sits in: at 200 %
// zoom in a narrow reader, a fixed 8rem ran past the window's edge (#283).
const inputClass =
  'min-w-[min(8rem,100%)] flex-1 bg-transparent text-ui text-primary placeholder-secondary outline-none'

/**
 * A recipient field whose entries are things rather than text.
 *
 * A comma-separated string is easy to write and hard to read: with four
 * recipients it is a paragraph, a typo in the middle is invisible, and
 * removing one means selecting exactly the right characters. Each entry
 * becoming a chip fixes all three — and lets the field say, at the moment it
 * is typed, that something is not an address, instead of at the moment the
 * send fails.
 *
 * The string underneath is untouched: it is still what the draft saves and
 * what the send path reads, and the token under the cursor stays text until a
 * separator ends it, so nothing hardens a half-typed address. All of that
 * lives in `recipientField`; this file is the keyboard and the markup.
 */
export function RecipientInput({ value, onChange, accountId, placeholder, autoFocus }: RecipientInputProps) {
  const { t } = useTranslation()
  const [suggestions, setSuggestions] = useState<Contact[]>([])
  const names = useContactNames()
  const allGroups = useValue(people$.groups)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const focusedRef = useRef(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const { committed, pending } = fieldParts(value)
  const accounts = useValue(accounts$)
  const account = accounts.find((candidate) => candidate.id === accountId)
  // Only an Exchange account has a directory to ask; asking anything else
  // would be a round trip per keystroke for an answer known to be empty.
  const hasDirectory = !!account && (account.provider === 'exchange' || !!account.ews_url)

  // A group is offered above the people, says how many it holds, and becomes
  // its members' addresses only when chosen (ADR-0052).
  const groupMatches = open ? matchingGroups(allGroups, pending) : []
  const total = groupMatches.length + suggestions.length

  // Suggestions follow the token under the cursor, debounced, and only while
  // the field has focus — a dropdown over a field nobody is in is in the way.
  useEffect(() => {
    if (!focusedRef.current) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const query = pending.trim()
      // Local first, so the list appears at once; the directory's answer, when
      // there is one, is merged in below it without repeating an address the
      // book already had.
      const [local, remote] = await Promise.all([
        suggestContacts(accountId, query),
        hasDirectory ? searchDirectory(accountId, query) : Promise.resolve([]),
        // The groups are read once, the first time somebody types a name.
        query && !people$.groupsLoaded.peek() ? loadGroups() : Promise.resolve(),
      ])
      if (cancelled) return
      const taken = new Set(local.map((contact) => contact.addr.toLowerCase()))
      const results = [...local, ...remote.filter((contact) => !taken.has(contact.addr.toLowerCase()))]
      setSuggestions(results)
      setActive(0)
      setOpen(results.length > 0 || matchingGroups(people$.groups.peek(), query).length > 0)
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pending, accountId, hasDirectory])

  const close = () => {
    setOpen(false)
    setSuggestions([])
  }

  // A name from the address book reads the way the reader orders names; one
  // seen only in a header is written as it came.
  const shownName = (contact: Contact) => (contact.known ? names.format(contact) : contact.name).trim()
  const accept = (contact: Contact) => {
    onChange(commitPending(value, formatContact({ ...contact, name: shownName(contact) })))
    close()
  }
  const acceptGroup = (group: ContactGroup) => {
    const entries = groupRecipients(group).map((member) =>
      formatContact({ name: names.format(member), addr: member.addr }),
    )
    onChange(commitPending(value, entries.join(', ')))
    close()
  }
  const acceptAt = (index: number) => {
    if (index < groupMatches.length) acceptGroup(groupMatches[index])
    else accept(suggestions[index - groupMatches.length])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (open && total > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((index) => (index + 1) % total)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => (index - 1 + total) % total)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        acceptAt(Math.min(active, total - 1))
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
    }

    // The separators do what they say: they end an entry. Enter and Tab do it
    // too, because that is what every other client has taught people.
    if (event.key === ',' || event.key === ';' || event.key === 'Enter' || event.key === 'Tab') {
      if (!pending.trim()) return
      event.preventDefault()
      onChange(commitPending(value))
      close()
      return
    }

    // Backspace at the start of an empty token opens the previous chip back
    // up rather than deleting it. A typo one character in is the common case,
    // and losing the whole address to fix it is a poor trade.
    if (event.key === 'Backspace' && !pending && committed.length > 0) {
      event.preventDefault()
      onChange(editAt(value, committed.length - 1))
      close()
    }
  }

  // A pasted list is a list, not one long address.
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    if (!/[,;\n]/.test(text)) return
    event.preventDefault()
    onChange(commitPending(setPending(value, `${pending}${text}`)))
    close()
  }

  return (
    <div className="relative min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-1">
        {committed.map((recipient, index) => {
          const label = recipient.name || recipient.address || recipient.raw
          const broken = recipient.status === 'malformed'
          return (
            <Chip
              key={`${recipient.raw}-${index}`}
              tone={broken ? 'danger' : 'neutral'}
              title={broken ? t('composer.recipients.notAnAddress') : recipient.address || recipient.raw}
              onClick={() => {
                onChange(editAt(value, index))
                inputRef.current?.focus()
              }}
              onRemove={() => onChange(removeAt(value, index))}
              removeLabel={t('composer.recipients.remove', { name: label })}
            >
              {label}
            </Chip>
          )
        })}
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={pending}
          dir={pending ? 'auto' : undefined}
          placeholder={committed.length === 0 ? placeholder : undefined}
          spellCheck={false}
          className={inputClass}
          onChange={(event) => onChange(setPending(value, event.target.value))}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => {
            focusedRef.current = true
            if (blurTimer.current) clearTimeout(blurTimer.current)
            void suggestContacts(accountId, pending.trim()).then((results) => {
              if (!focusedRef.current) return
              setSuggestions(results)
              setActive(0)
              setOpen(results.length > 0)
            })
          }}
          onBlur={() => {
            // Delayed so a mousedown on a suggestion registers before the
            // dropdown closes. Leaving the field also settles what was being
            // typed: someone who tabs away having written a whole address
            // meant it, and should not find it gone.
            blurTimer.current = setTimeout(() => {
              focusedRef.current = false
              setOpen(false)
              if (pending.trim()) onChange(commitPending(value))
            }, 150)
          }}
        />
      </div>
      {open && total > 0 && (
        <ul className="absolute start-0 end-0 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded-control-sm border border-border bg-chats py-1 shadow-overlay">
          {groupMatches.map((group, index) => (
            <li
              key={`group:${group.id}`}
              onMouseDown={(event) => {
                event.preventDefault()
                acceptGroup(group)
              }}
              onMouseEnter={() => setActive(index)}
              className={`cursor-pointer px-3 py-1.5 text-ui ${index === active ? 'bg-accent/10' : ''}`}
            >
              <span className="text-primary">{group.name}</span>{' '}
              <span className="text-secondary">
                ·{' '}
                {t('composer.recipients.groupCount', {
                  count: groupRecipients(group).length,
                  defaultValue: 'group, {count, plural, one {# person} other {# people}}',
                })}
              </span>
            </li>
          ))}
          {suggestions.map((contact, contactIndex) => {
            const index = contactIndex + groupMatches.length
            const name = shownName(contact)
            return (
              <li
                key={contact.addr}
                // mousedown, not click, so it fires before the input's blur.
                onMouseDown={(event) => {
                  event.preventDefault()
                  accept(contact)
                }}
                onMouseEnter={() => setActive(index)}
                className={`cursor-pointer px-3 py-1.5 text-ui ${index === active ? 'bg-accent/10' : ''}`}
              >
                {name && name.toLowerCase() !== contact.addr.toLowerCase() ? (
                  <span>
                    <span className="text-primary">{name}</span>{' '}
                    <span className="text-secondary">{`<${contact.addr}>`}</span>
                    {/* Only for somebody the reader keeps. An address seen in a
                      header carries no such fact, and inventing one would put
                      a stranger's employer on screen as if it were known. */}
                    {contact.known && contact.organisation && (
                      <span className="text-2xs text-secondary/75"> · {contact.organisation}</span>
                    )}
                    {/* Said, because it is a different claim: not somebody the
                      reader keeps, but somebody the organisation lists. */}
                    {contact.directory && (
                      <span className="text-2xs text-secondary/75"> · {t('composer.recipients.fromDirectory')}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-primary">{contact.addr}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
