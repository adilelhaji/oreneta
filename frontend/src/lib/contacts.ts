import { invoke } from './bridge'
import type { Contact, Person } from '../types'

// Recipient autocomplete suggestions, drawn from the senders of cached messages
// by the sidecar. `accountId` scopes the lookup to one account (pass "" for a
// unified search across all accounts).
export async function suggestContacts(accountId: string, query: string, limit = 8): Promise<Contact[]> {
  try {
    const res = await invoke<{ contacts?: Contact[] }>('mail.suggestContacts', {
      account: accountId,
      query,
      limit,
    })
    return res.contacts ?? []
  } catch {
    return []
  }
}

// Render a contact as a recipient header entry: "Name <addr>" when a distinct
// display name exists, otherwise the bare address.
export function formatContact(c: Contact): string {
  const name = c.name.trim()
  if (name && name.toLowerCase() !== c.addr.toLowerCase()) {
    return `${name} <${c.addr}>`
  }
  return c.addr
}

/**
 * Ask the organisation's directory who matches, for accounts that have one.
 *
 * Exchange only, in practice: any other account answers with nobody, which is
 * why callers may ask without checking. Each address a person has is its own
 * suggestion, because the writer is choosing where to send.
 */
export async function searchDirectory(accountId: string, query: string): Promise<Contact[]> {
  if (!accountId || query.trim().length < 2) return []
  try {
    const res = await invoke<{ people?: Person[] }>('directory.search', { account: accountId, query })
    return (res.people ?? []).flatMap((person) =>
      person.emails.map((email) => ({
        name: person.name,
        addr: email.addr,
        known: true,
        organisation: person.organisation,
        directory: true,
      })),
    )
  } catch {
    return []
  }
}
