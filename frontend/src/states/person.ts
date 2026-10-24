import { observable } from '@legendapp/state'
import type { Account, Person } from '../types'
import { selectSidebarPanel } from './sidebar'
import type { AppModule } from './ui'

// Who the Persona panel of the app's sidebar is about (ADR-0069 §4). Nothing
// here is stored: the remembered panel keeps the type `person`, never the
// person (§2), and nobody is guessed.
//
// - In mail, the person is the open conversation's: its one participant who
//   is not one of the reader's own accounts, or the one picked from its list
//   (or from the participant menu's «History with …»). A pick is held with the
//   conversation and the account it was made in, so another conversation, or
//   the same thread in another account, never shows it.
// - In Persones, the person is the selected contact, `people$.selectedId`,
//   read as it is: selecting a contact is what sets it. What is held here is
//   only what the panel asked for that contact: the address, when it has
//   several, and the account, when its book is nobody's (§4). Both are held
//   with the contact they were chosen for.
// - In the other modules there is nobody.

/** A participant picked in mail, with the conversation and the account it was picked in. */
export type PickedParticipant = { thread: string; account: string; address: string; name: string }

/** What was chosen for one contact in Persones. */
export type ContactChoice = { contact: string; address?: string; account?: string }

/** A conversation's participant, as the Conversa panel lists them. */
export type PanelParticipant = { name: string; email: string; isSelf: boolean }

export const person$ = observable({
  /** Mail: the participant picked, in the conversation it was picked in. */
  participant: null as PickedParticipant | null,
  /** Persones: the address and the account chosen for a contact. */
  contact: null as ContactChoice | null,
})

/** Picks a participant of the conversation on screen, or forgets the pick (back to its list). */
export function pickParticipant(pick: PickedParticipant | null) {
  person$.participant.set(pick)
}

/**
 * «History with …» in the participant menu of the Conversa panel: that
 * person's history in the Persona panel of the sidebar, which stays as it is
 * drawn (beside the content or as an overlay), saving nothing but the panel.
 */
export function showParticipantHistory(pick: PickedParticipant) {
  pickParticipant(pick)
  selectSidebarPanel('person')
}

/** Chooses the address or the account for a contact; a choice for another contact is forgotten. */
export function chooseForContact(contact: string, choice: { address?: string; account?: string }) {
  const current = person$.contact.peek()
  person$.contact.set({ ...(current?.contact === contact ? current : {}), ...choice, contact })
}

/** The accounts a history can be read from: those with mail, not feeds. */
export function historyAccounts(accounts: Account[]): Account[] {
  return accounts.filter((account) => account.provider !== 'rss' && account.auth_type !== 'rss')
}

/** What the Persona panel shows. */
export type PersonPanelView =
  /** Nobody to show: what to select, and where. */
  | { kind: 'empty'; where: 'mail' | 'people' | 'elsewhere' }
  /** Mail: the conversation's messages are still another conversation's. */
  | { kind: 'loading' }
  /** Mail: nobody in the conversation but the reader's own accounts. */
  | { kind: 'nobody' }
  /** Mail: several people; the conversation's list, to pick one. */
  | { kind: 'participants'; thread: string; account: string; participants: PanelParticipant[] }
  /** Mail: one person's history in the conversation's account; `back` goes back to the choice. */
  | { kind: 'history'; thread: string; account: string; address: string; name: string; back: boolean }
  /** Persones: a contact with no address to look up. */
  | { kind: 'noAddress'; contact: Person }
  /**
   * Persones: a contact, its addresses and the account to look in. `address`
   * and `account` are empty until chosen; `accounts` is the choice when the
   * contact's book is nobody's, and null when it is an account's.
   */
  | {
      kind: 'contact'
      contact: Person
      addresses: string[]
      address: string
      accounts: Account[] | null
      account: string
    }

export type PersonPanelInput = {
  module: AppModule
  /** Mail: the conversation on screen, or null when there is none. */
  conversation: { thread: string; account: string; loading: boolean; participants: PanelParticipant[] } | null
  participant: PickedParticipant | null
  /** Persones: the selected contact, or null. */
  contact: Person | null
  choice: ContactChoice | null
  accounts: Account[]
}

/** A contact's addresses to look up, each once (an address matches whole, in any case). */
export function contactAddresses(contact: Person): string[] {
  const seen = new Set<string>()
  const addresses: string[] = []
  for (const email of contact.emails) {
    const address = email.addr.trim()
    const key = address.toLowerCase()
    if (!address.includes('@') || seen.has(key)) continue
    seen.add(key)
    addresses.push(address)
  }
  return addresses
}

/**
 * Who the Persona panel is about, and what it still needs to know (ADR-0069
 * §4). In mail, the conversation's account, always; in Persones, the account
 * of the contact's book, or the one chosen when the book is nobody's. It never
 * picks a person, an address or an account by itself.
 */
export function resolvePersonPanel(input: PersonPanelInput): PersonPanelView {
  if (input.module === 'mail') {
    const conversation = input.conversation
    if (!conversation) return { kind: 'empty', where: 'mail' }
    if (conversation.loading) return { kind: 'loading' }
    const others = conversation.participants.filter((participant) => !participant.isSelf)
    const sole = others.length === 1 ? others[0] : undefined
    const pick = input.participant
    const picked =
      pick && pick.thread === conversation.thread && pick.account === conversation.account
        ? conversation.participants.find((participant) => participant.email === pick.address.trim().toLowerCase())
        : undefined
    const chosen = picked ?? sole
    if (chosen)
      return {
        kind: 'history',
        thread: conversation.thread,
        account: conversation.account,
        address: chosen.email,
        name: chosen.name || chosen.email,
        // A pick that is not the one person shown anyway goes back to the choice.
        back: !!picked && picked !== sole,
      }
    if (others.length === 0) return { kind: 'nobody' }
    return { kind: 'participants', thread: conversation.thread, account: conversation.account, participants: others }
  }
  if (input.module === 'people') {
    const contact = input.contact
    if (!contact) return { kind: 'empty', where: 'people' }
    const addresses = contactAddresses(contact)
    if (addresses.length === 0) return { kind: 'noAddress', contact }
    const choice = input.choice?.contact === contact.id ? input.choice : null
    const address = addresses.length === 1 ? addresses[0] : (addresses.find((a) => a === choice?.address) ?? '')
    const mail = historyAccounts(input.accounts)
    // The account of the contact's book (`contact_sources.account`); a book
    // that is nobody's, or an account no longer here, asks for one.
    const book = mail.find((account) => account.id === contact.account)
    return {
      kind: 'contact',
      contact,
      addresses,
      address,
      accounts: book ? null : mail,
      account: book ? book.id : (mail.find((account) => account.id === choice?.account)?.id ?? ''),
    }
  }
  return { kind: 'empty', where: 'elsewhere' }
}
