import { invoke } from './bridge'
import type { Account, Message } from '../types'
import type { FilterFacet } from '../states/ui'

export function isRssAccount(account: Account | undefined, accountId: string): boolean {
  return account?.provider === 'rss' || account?.auth_type === 'rss' || accountId.startsWith('rss-')
}

// Pure thread filter shared by the chat thread list and kanban columns. `keepId`
// is an open thread to keep visible even when it no longer matches the filter
// (e.g. selecting an unread thread marks it read but it shouldn't vanish).
/**
 * Narrows a page the core already narrowed, by every facet asked for.
 *
 * The core answers the same question, so this is not the filter — it is what
 * keeps a row in place for the moment after it stops qualifying. A thread read
 * while the unread filter is on must not vanish under the pointer that read
 * it; `keepId` and `keepIds` are what hold it there until the list is asked
 * for again.
 */
export function filterThreads(
  threads: Message[],
  facets: FilterFacet[],
  keepId?: string,
  keepIds?: Record<string, boolean>,
): Message[] {
  const kept = (thread: Message) => thread.thread_id === keepId || !!keepIds?.[thread.thread_id]
  let out = threads
  if (facets.includes('unread')) {
    out = out.filter((thread) => thread.unread || kept(thread))
  }
  if (facets.includes('starred')) {
    out = out.filter((thread) => thread.starred || thread.has_starred_items || kept(thread))
  }
  if (facets.includes('attachments')) {
    out = out.filter((thread) => thread.has_attachments || kept(thread))
  }
  const labelFacet = facets.find((facet) => facet.startsWith('label:'))
  if (labelFacet) {
    const labelId = labelFacet.slice('label:'.length)
    out = out.filter((thread) => thread.labels?.includes(labelId) || kept(thread))
  }
  // Nothing for 'snoozed': it is answered by a different query, and every row
  // that came back is one of its own.
  return out
}

// Mark a set of threads read on the backend. Mail accounts are marked folder-wide
// in one call each; RSS feeds (no folder-wide flag) are marked per-thread. The
// caller owns the optimistic local-state update.
export async function markThreadsReadRemote(threads: Message[], accounts: Account[], folderId: string): Promise<void> {
  const mailAccounts = new Set<string>()
  const rssThreadIds: string[] = []
  for (const thread of threads) {
    const account = accounts.find((acc) => acc.id === thread.account_id)
    if (isRssAccount(account, thread.account_id)) {
      rssThreadIds.push(thread.thread_id)
    } else {
      mailAccounts.add(thread.account_id)
    }
  }

  await Promise.all([
    ...Array.from(mailAccounts).map((accountId) =>
      invoke('mail.markAllRead', { account_id: accountId, folder_id: folderId }).catch((err) =>
        console.error('markAllRead failed:', err),
      ),
    ),
    ...rssThreadIds.map((threadId) =>
      invoke('mail.markRead', { thread_id: threadId }).catch((err) => console.error('markAllRead (rss) failed:', err)),
    ),
  ])
}
